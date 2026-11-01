//! `/web/projects`: the Projects tab. Each profile's GitHub repos (their own
//! account and the Opus-Systems-OS org, through that profile's own token) and
//! their Jarvis projects (ones that live here, in `db.rs`). A repo's 3D models
//! (`.glb .gltf .stl`) are listed from its tree and relayed one file at a time
//! as an attachment under `Content-Security-Policy: sandbox`, so the page can
//! read the bytes but nothing in them ever runs here. GitHub is reached at
//! `api.github.com` only; the token never leaves this process.

use crate::config::Profile;
use crate::db::Project;
use crate::error::{Error, Result};
use crate::intel::USER_AGENT;
use crate::AppState;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use futures_util::StreamExt;
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const ORG: &str = "Opus-Systems-OS";
const API: &str = "https://api.github.com";
const TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PAGES: u32 = 5;
const MAX_MODELS: usize = 50;
/// The largest file relayed (a model, a doc, a source file).
const MAX_FILE_BYTES: u64 = 40 * 1024 * 1024;
/// Files listed per repo; a bigger tree is cut and says so.
const MAX_TREE: usize = 5000;
/// The longest path, and the largest file Jarvis writes (text).
const MAX_PATH: usize = 1024;
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const MAX_PROJECTS: i64 = 200;
const NAME_MAX: usize = 100;
const DESCRIPTION_MAX: usize = 350;
const TIMEOUT: Duration = Duration::from_secs(15);
const MODEL_EXTS: [&str; 3] = ["glb", "gltf", "stl"];

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Repo {
    pub owner: String,
    pub name: String,
    pub private: bool,
    pub description: Option<String>,
    pub language: Option<String>,
    pub pushed_at: Option<String>,
    pub html_url: String,
    pub default_branch: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TreeFile {
    pub path: String,
    pub size: u64,
}

/// A repo's files (blobs) on its default branch.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct Tree {
    pub files: Vec<TreeFile>,
    /// More than `MAX_TREE` files, or GitHub cut the tree itself.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Github {
    pub login: String,
    pub repos: Vec<Repo>,
}

/// Per profile: the repo list, and each repo's tree.
#[derive(Default)]
pub struct Cache {
    lists: Mutex<HashMap<String, (Instant, Github)>>,
    trees: Mutex<HashMap<String, (Instant, Tree)>>,
}

fn upstream(what: &str) -> Error {
    Error::Internal(format!("GitHub: {what}"))
}

fn token(p: &Profile) -> Result<&str> {
    p.github_token
        .as_ref()
        .map(|t| t.expose_secret())
        .ok_or_else(|| {
            Error::InvalidRequest(
                "no GitHub token for this profile yet (GITHUB_TOKEN_FILE / GITHUB_POWERS_TOKEN_FILE)"
                    .into(),
            )
        })
}

fn request(
    state: &AppState,
    method: reqwest::Method,
    url: &str,
    token: &str,
) -> reqwest::RequestBuilder {
    state
        .http
        .request(method, url)
        .header(header::USER_AGENT, USER_AGENT)
        .header(header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token)
        .timeout(TIMEOUT)
}

async fn get_json(state: &AppState, path: &str, token: &str) -> Result<Value> {
    let res = request(state, reqwest::Method::GET, &format!("{API}{path}"), token)
        .send()
        .await
        .map_err(|_| upstream("unreachable"))?;
    match res.status().as_u16() {
        200 => res.json().await.map_err(|_| upstream("not JSON")),
        401 => Err(upstream("the token was refused (expired or revoked?)")),
        404 => Err(Error::NotFound),
        s => Err(upstream(&format!("HTTP {s}"))),
    }
}

/// Repos from `/user/repos` that are theirs or the org's.
pub fn keep_repos(login: &str, page: &Value) -> Vec<Repo> {
    page.as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let owner = r["owner"]["login"].as_str()?;
            if !(owner.eq_ignore_ascii_case(login) || owner.eq_ignore_ascii_case(ORG)) {
                return None;
            }
            let s = |k: &str| r[k].as_str().map(str::to_owned);
            Some(Repo {
                owner: owner.to_owned(),
                name: s("name")?,
                private: r["private"].as_bool().unwrap_or(true),
                description: s("description"),
                language: s("language"),
                pushed_at: s("pushed_at"),
                html_url: s("html_url")?,
                default_branch: s("default_branch").unwrap_or_else(|| "main".into()),
            })
        })
        .collect()
}

async fn listing(state: &AppState, p: &Profile) -> Result<Github> {
    if let Some((at, g)) = state
        .intel
        .projects
        .lists
        .lock()
        .expect("projects")
        .get(&p.id)
    {
        if at.elapsed() < TTL {
            return Ok(g.clone());
        }
    }
    let token = token(p)?;
    let me = get_json(state, "/user", token).await?;
    let login = me["login"]
        .as_str()
        .ok_or_else(|| upstream("no login"))?
        .to_owned();
    let mut repos = Vec::new();
    for page in 1..=MAX_PAGES {
        let v = get_json(
            state,
            &format!("/user/repos?affiliation=owner,organization_member&sort=pushed&per_page=100&page={page}"),
            token,
        )
        .await?;
        let n = v.as_array().map_or(0, Vec::len);
        repos.extend(keep_repos(&login, &v));
        if n < 100 {
            break;
        }
    }
    let g = Github { login, repos };
    state
        .intel
        .projects
        .lists
        .lock()
        .expect("projects")
        .insert(p.id.clone(), (Instant::now(), g.clone()));
    Ok(g)
}

#[derive(Serialize)]
pub struct Listing {
    pub github: Option<Github>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_error: Option<String>,
    pub local: Vec<Project>,
}

/// `GET /web/projects`.
pub async fn list(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
) -> Result<Json<Listing>> {
    let local = state.db.projects(&p.id)?;
    let (github, github_error) = match listing(&state, &p).await {
        Ok(g) => (Some(g), None),
        Err(e) => (None, Some(e.to_string())),
    };
    Ok(Json(Listing {
        github,
        github_error,
        local,
    }))
}

/// The repo, if it is one of this profile's.
async fn repo(state: &AppState, p: &Profile, owner: &str, name: &str) -> Result<Repo> {
    listing(state, p)
        .await?
        .repos
        .into_iter()
        .find(|r| r.owner.eq_ignore_ascii_case(owner) && r.name.eq_ignore_ascii_case(name))
        .ok_or(Error::NotFound)
}

fn is_model(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| MODEL_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// A recursive git tree's files, up to `MAX_TREE`.
pub fn files_in_tree(tree: &Value) -> Tree {
    let blobs: Vec<TreeFile> = tree["tree"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["type"].as_str() == Some("blob"))
        .filter_map(|e| {
            Some(TreeFile {
                path: e["path"].as_str()?.to_owned(),
                size: e["size"].as_u64().unwrap_or(0),
            })
        })
        .collect();
    Tree {
        truncated: blobs.len() > MAX_TREE || tree["truncated"].as_bool() == Some(true),
        files: blobs.into_iter().take(MAX_TREE).collect(),
    }
}

/// The 3D models in a tree, small enough to relay.
pub fn models_in(tree: &Tree) -> Vec<TreeFile> {
    tree.files
        .iter()
        .filter(|f| is_model(&f.path) && f.size <= MAX_FILE_BYTES)
        .take(MAX_MODELS)
        .cloned()
        .collect()
}

async fn tree_of(state: &AppState, p: &Profile, r: &Repo) -> Result<Tree> {
    let key = format!("{}:{}/{}", p.id, r.owner, r.name).to_lowercase();
    if let Some((at, t)) = state.intel.projects.trees.lock().expect("trees").get(&key) {
        if at.elapsed() < TTL {
            return Ok(t.clone());
        }
    }
    let tree = get_json(
        state,
        &format!(
            "/repos/{}/{}/git/trees/{}?recursive=1",
            r.owner,
            r.name,
            urlencoding(&r.default_branch)
        ),
        token(p)?,
    )
    .await;
    // An empty repo has no tree yet.
    let tree = match tree {
        Ok(t) => files_in_tree(&t),
        Err(Error::NotFound) => Tree::default(),
        Err(e) => return Err(e),
    };
    state
        .intel
        .projects
        .trees
        .lock()
        .expect("trees")
        .insert(key, (Instant::now(), tree.clone()));
    Ok(tree)
}

fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// `GET /web/projects/github/{owner}/{repo}/models`.
pub async fn models(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
    Path((owner, name)): Path<(String, String)>,
) -> Result<Json<Vec<TreeFile>>> {
    let r = repo(&state, &p, &owner, &name).await?;
    Ok(Json(models_in(&tree_of(&state, &p, &r).await?)))
}

/// `GET /web/projects/github/{owner}/{repo}/tree`: every file, for the browser.
pub async fn tree(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
    Path((owner, name)): Path<(String, String)>,
) -> Result<Json<Tree>> {
    let r = repo(&state, &p, &owner, &name).await?;
    Ok(Json(tree_of(&state, &p, &r).await?))
}

#[derive(Deserialize)]
pub struct FileQuery {
    path: String,
}

/// `GET /web/projects/github/{owner}/{repo}/file?path=`: one file the tree
/// listed (a model, a doc, source), as an attachment that never renders.
pub async fn file(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
    Path((owner, name)): Path<(String, String)>,
    Query(q): Query<FileQuery>,
) -> Result<Response> {
    let r = repo(&state, &p, &owner, &name).await?;
    let listed = tree_of(&state, &p, &r).await?;
    if !listed
        .files
        .iter()
        .any(|f| f.path == q.path && f.size <= MAX_FILE_BYTES)
    {
        return Err(Error::NotFound);
    }
    let path: Vec<String> = q.path.split('/').map(urlencoding).collect();
    let url = format!(
        "{API}/repos/{}/{}/contents/{}?ref={}",
        r.owner,
        r.name,
        path.join("/"),
        urlencoding(&r.default_branch)
    );
    let res = request(&state, reqwest::Method::GET, &url, token(&p)?)
        .header(header::ACCEPT, "application/vnd.github.raw")
        .send()
        .await
        .map_err(|_| upstream("unreachable"))?;
    if !res.status().is_success() {
        return Err(upstream(&format!("HTTP {}", res.status().as_u16())));
    }
    let mut body = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| upstream("read failed"))?;
        if (body.len() + chunk.len()) as u64 > MAX_FILE_BYTES {
            return Err(upstream("too large"));
        }
        body.extend_from_slice(&chunk);
    }
    let mut res = body.into_response();
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=300"),
    );
    Ok(res)
}

/// A path inside a repo: relative, no empty, `.`, `..` or `.git` segments,
/// and not under `.github/` — Jarvis's tools write here, and a page he reads
/// could steer him into planting a workflow that runs with the repo's secrets.
pub fn path_ok(path: &str) -> bool {
    let top = path.split('/').next().unwrap_or_default();
    (1..=MAX_PATH).contains(&path.len())
        && !top.eq_ignore_ascii_case(".github")
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != ".." && !s.eq_ignore_ascii_case(".git"))
}

/// A GitHub write; its refusals are said plainly (they are his to fix).
async fn send_json(
    state: &AppState,
    method: reqwest::Method,
    path: &str,
    token: &str,
    body: &Value,
) -> Result<Value> {
    let res = request(state, method, &format!("{API}{path}"), token)
        .json(body)
        .send()
        .await
        .map_err(|_| upstream("unreachable"))?;
    let status = res.status().as_u16();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    let why = v["message"].as_str().unwrap_or("refused");
    match status {
        200 | 201 => Ok(v),
        401 => Err(upstream("the token was refused (expired or revoked?)")),
        403 | 404 => Err(Error::InvalidRequest(format!(
            "GitHub refused ({why}): the token needs the repo scope and write access to this repo"
        ))),
        409 | 422 => Err(Error::InvalidRequest(format!(
            "GitHub refused ({why}); the branch may have moved meanwhile, try again"
        ))),
        s => Err(upstream(&format!("HTTP {s}: {why}"))),
    }
}

/// A branch in a refs URL: its `/`s stay, each part encoded.
fn ref_path(r: &Repo) -> String {
    r.default_branch
        .split('/')
        .map(urlencoding)
        .collect::<Vec<_>>()
        .join("/")
}

/// The branch head now: its commit and that commit's tree.
async fn head(state: &AppState, token: &str, r: &Repo) -> Result<(String, String)> {
    let base = format!("/repos/{}/{}", r.owner, r.name);
    let branch = ref_path(r);
    let commit = get_json(state, &format!("{base}/git/ref/heads/{branch}"), token).await?["object"]
        ["sha"]
        .as_str()
        .ok_or_else(|| upstream("no head"))?
        .to_owned();
    let tree = get_json(state, &format!("{base}/git/commits/{commit}"), token).await?["tree"]
        ["sha"]
        .as_str()
        .ok_or_else(|| upstream("no tree"))?
        .to_owned();
    Ok((commit, tree))
}

/// One commit on the default branch changing `entries` (git tree entries);
/// a branch that moved meanwhile is refused, not overwritten.
async fn commit(
    state: &AppState,
    p: &Profile,
    r: &Repo,
    parent: (String, String),
    message: &str,
    entries: Vec<Value>,
) -> Result<String> {
    let token = token(p)?;
    let base = format!("/repos/{}/{}", r.owner, r.name);
    let tree = send_json(
        state,
        reqwest::Method::POST,
        &format!("{base}/git/trees"),
        token,
        &serde_json::json!({ "base_tree": parent.1, "tree": entries }),
    )
    .await?;
    let made = send_json(
        state,
        reqwest::Method::POST,
        &format!("{base}/git/commits"),
        token,
        &serde_json::json!({ "message": message, "tree": tree["sha"], "parents": [parent.0] }),
    )
    .await?;
    let sha = made["sha"].as_str().ok_or_else(|| upstream("no commit"))?;
    send_json(
        state,
        reqwest::Method::PATCH,
        &format!("{base}/git/refs/heads/{}", ref_path(r)),
        token,
        &serde_json::json!({ "sha": sha, "force": false }),
    )
    .await?;
    let key = format!("{}:{}/{}", p.id, r.owner, r.name).to_lowercase();
    state
        .intel
        .projects
        .trees
        .lock()
        .expect("trees")
        .remove(&key);
    tracing::info!(owner = %r.owner, repo = %r.name, commit = %sha, "repo changed from the HUD");
    Ok(sha.to_owned())
}

fn message(m: &Option<String>, default: String) -> Result<String> {
    let m = m.as_deref().map(str::trim).filter(|m| !m.is_empty());
    match m {
        Some(m) if m.chars().count() > DESCRIPTION_MAX => Err(Error::InvalidRequest(format!(
            "message: at most {DESCRIPTION_MAX} characters"
        ))),
        Some(m) => Ok(m.to_owned()),
        None => Ok(default),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriteFile {
    pub path: String,
    /// The whole file, as text.
    pub content: String,
    pub message: Option<String>,
}

/// `POST /web/projects/github/{owner}/{repo}/write`: create or replace one
/// text file, as one commit on the default branch.
pub async fn write_file(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
    Path((owner, name)): Path<(String, String)>,
    body: std::result::Result<Json<WriteFile>, JsonRejection>,
) -> Result<Json<Value>> {
    let Json(req) = body.map_err(|e| Error::InvalidRequest(e.body_text()))?;
    if !path_ok(&req.path) {
        return Err(Error::InvalidRequest("path: a file inside the repo".into()));
    }
    if req.content.len() > MAX_WRITE_BYTES {
        return Err(Error::InvalidRequest(format!(
            "content: at most {} KB",
            MAX_WRITE_BYTES / 1024
        )));
    }
    let message = message(&req.message, format!("Update {} (from Jarvis)", req.path))?;
    let r = repo(&state, &p, &owner, &name).await?;
    let parent = head(&state, token(&p)?, &r).await?;
    let entry = serde_json::json!({
        "path": req.path, "mode": "100644", "type": "blob", "content": req.content,
    });
    let sha = commit(&state, &p, &r, parent, &message, vec![entry]).await?;
    Ok(Json(serde_json::json!({ "path": req.path, "commit": sha })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MoveFile {
    pub from: String,
    pub to: String,
    pub message: Option<String>,
}

/// `POST /web/projects/github/{owner}/{repo}/move`: rename a file within the
/// repo, as one commit; never over a file that is already there.
pub async fn move_file(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
    Path((owner, name)): Path<(String, String)>,
    body: std::result::Result<Json<MoveFile>, JsonRejection>,
) -> Result<Json<Value>> {
    let Json(req) = body.map_err(|e| Error::InvalidRequest(e.body_text()))?;
    if !path_ok(&req.from) || !path_ok(&req.to) || req.from == req.to {
        return Err(Error::InvalidRequest(
            "from and to: two different files inside the repo".into(),
        ));
    }
    let message = message(
        &req.message,
        format!("Move {} to {} (from Jarvis)", req.from, req.to),
    )?;
    let r = repo(&state, &p, &owner, &name).await?;
    let token = token(&p)?;
    let parent = head(&state, token, &r).await?;
    let tree = get_json(
        &state,
        &format!(
            "/repos/{}/{}/git/trees/{}?recursive=1",
            r.owner, r.name, parent.1
        ),
        token,
    )
    .await?;
    let entry = |path: &str| {
        tree["tree"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|e| e["path"].as_str() == Some(path))
            .cloned()
    };
    let src = entry(&req.from)
        .filter(|e| e["type"].as_str() == Some("blob"))
        .ok_or(Error::NotFound)?;
    if tree["truncated"].as_bool() == Some(true) {
        return Err(Error::InvalidRequest(
            "this repo is too big to check a move safely".into(),
        ));
    }
    // The destination taken, or a file where one of its folders would be.
    if entry(&req.to).is_some()
        || tree["tree"].as_array().into_iter().flatten().any(|e| {
            e["path"].as_str().is_some_and(|x| {
                req.to.starts_with(&format!("{x}/")) && e["type"].as_str() == Some("blob")
            })
        })
    {
        return Err(Error::InvalidRequest(format!(
            "{} is already there",
            req.to
        )));
    }
    let entries = vec![
        serde_json::json!({ "path": req.to, "mode": src["mode"], "type": "blob", "sha": src["sha"] }),
        serde_json::json!({ "path": req.from, "mode": src["mode"], "type": "blob", "sha": Value::Null }),
    ];
    let sha = commit(&state, &p, &r, parent, &message, entries).await?;
    Ok(Json(
        serde_json::json!({ "from": req.from, "to": req.to, "commit": sha }),
    ))
}

/// GitHub's repository names: letters, digits, `.`, `-`, `_`, not `.` or `..`.
pub fn repo_name_ok(name: &str) -> bool {
    (1..=NAME_MAX).contains(&name.len())
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn description(d: &Option<String>) -> Result<String> {
    let d = d.as_deref().unwrap_or("").trim();
    if d.chars().count() > DESCRIPTION_MAX || d.chars().any(char::is_control) {
        return Err(Error::InvalidRequest(format!(
            "description: at most {DESCRIPTION_MAX} plain characters"
        )));
    }
    Ok(d.to_owned())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewRepo {
    pub name: String,
    #[serde(default = "yes")]
    pub private: bool,
    pub description: Option<String>,
    /// In Opus-Systems-OS rather than their own account.
    #[serde(default)]
    pub org: bool,
}

fn yes() -> bool {
    true
}

/// `POST /web/projects/github`: a new repo, private unless said otherwise.
pub async fn create_repo(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
    body: std::result::Result<Json<NewRepo>, JsonRejection>,
) -> Result<Json<Repo>> {
    let Json(req) = body.map_err(|e| Error::InvalidRequest(e.body_text()))?;
    let name = req.name.trim();
    if !repo_name_ok(name) {
        return Err(Error::InvalidRequest(
            "name: 1–100 letters, digits, '.', '-' or '_'".into(),
        ));
    }
    let description = description(&req.description)?;
    let path = if req.org {
        format!("/orgs/{ORG}/repos")
    } else {
        "/user/repos".to_owned()
    };
    let res = request(
        &state,
        reqwest::Method::POST,
        &format!("{API}{path}"),
        token(&p)?,
    )
    .json(&serde_json::json!({
        "name": name,
        "private": req.private,
        "description": description,
        "auto_init": true,
    }))
    .send()
    .await
    .map_err(|_| upstream("unreachable"))?;
    let status = res.status().as_u16();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if status != 201 {
        let why = v["errors"][0]["message"]
            .as_str()
            .or(v["message"].as_str())
            .unwrap_or("refused");
        return Err(match status {
            422 => Error::InvalidRequest(format!("GitHub: {why}")),
            403 | 404 => Error::InvalidRequest(format!(
                "GitHub refused ({why}): the token needs the repo scope{}",
                if req.org {
                    ", and you need permission to create repos in the org"
                } else {
                    ""
                }
            )),
            _ => upstream(&format!("HTTP {status}: {why}")),
        });
    }
    let login = v["owner"]["login"].as_str().unwrap_or_default().to_owned();
    let repo = keep_repos(&login, &Value::Array(vec![v]))
        .pop()
        .ok_or_else(|| upstream("unexpected reply"))?;
    state
        .intel
        .projects
        .lists
        .lock()
        .expect("projects")
        .remove(&p.id);
    tracing::info!(owner = %repo.owner, repo = %repo.name, "repo created from the HUD");
    Ok(Json(repo))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewProject {
    pub name: String,
    pub description: Option<String>,
    /// The Jarvis conversation it starts in (`sesn_…`); its outputs are its files.
    pub session_id: Option<String>,
}

fn session_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// `POST /web/projects/local`: a Jarvis project.
pub async fn create_local(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
    body: std::result::Result<Json<NewProject>, JsonRejection>,
) -> Result<Json<Project>> {
    let Json(req) = body.map_err(|e| Error::InvalidRequest(e.body_text()))?;
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > NAME_MAX || name.chars().any(char::is_control) {
        return Err(Error::InvalidRequest(format!(
            "name: 1–{NAME_MAX} plain characters"
        )));
    }
    let description = description(&req.description)?;
    let session = req.session_id.as_deref().filter(|s| !s.is_empty());
    if session.is_some_and(|s| !session_ok(s)) {
        return Err(Error::InvalidRequest(
            "session_id is not a session id".into(),
        ));
    }
    state
        .db
        .add_project(&p.id, name, &description, session, MAX_PROJECTS)?
        .map(Json)
        .ok_or_else(|| Error::InvalidRequest(format!("at most {MAX_PROJECTS} projects")))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectSession {
    pub session_id: String,
}

/// `POST /web/projects/local/{id}/session`: the conversation it continues in
/// now (its first one ended, or it never had one).
pub async fn set_session(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
    Path(id): Path<i64>,
    body: std::result::Result<Json<ProjectSession>, JsonRejection>,
) -> Result<Json<Value>> {
    let Json(req) = body.map_err(|e| Error::InvalidRequest(e.body_text()))?;
    if !session_ok(&req.session_id) {
        return Err(Error::InvalidRequest(
            "session_id is not a session id".into(),
        ));
    }
    if !state.db.set_project_session(&p.id, id, &req.session_id)? {
        return Err(Error::NotFound);
    }
    Ok(Json(
        serde_json::json!({ "id": id, "session_id": req.session_id }),
    ))
}

/// `POST /web/projects/local/{id}/remove`.
pub async fn remove_local(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
    Path(id): Path<i64>,
) -> Result<Json<Value>> {
    if !state.db.remove_project(&p.id, id)? {
        return Err(Error::NotFound);
    }
    Ok(Json(serde_json::json!({ "id": id, "removed": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_their_own_and_the_orgs_repos_are_kept() {
        let page = json!([
          {"name":"J.A.R.V.I.S-Web","private":false,"html_url":"https://github.com/Opus-Systems-OS/J.A.R.V.I.S-Web","default_branch":"main","owner":{"login":"Opus-Systems-OS"},"language":"Rust"},
          {"name":"dotfiles","private":true,"html_url":"https://github.com/jpwalker/dotfiles","default_branch":"master","owner":{"login":"JPWalker"}},
          {"name":"other","private":false,"html_url":"https://github.com/someone/other","owner":{"login":"someone"}}
        ]);
        let repos = keep_repos("jpwalker", &page);
        assert_eq!(
            repos.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            ["J.A.R.V.I.S-Web", "dotfiles"]
        );
        assert_eq!(repos[1].default_branch, "master");
        assert!(repos[1].private);
    }

    #[test]
    fn trees_keep_every_file_and_models_are_picked_out() {
        let tree = json!({"tree":[
          {"path":"assets/suit.glb","type":"blob","size":2048},
          {"path":"assets/Helmet.STL","type":"blob","size":10},
          {"path":"assets","type":"tree"},
          {"path":"huge.gltf","type":"blob","size": 50u64 * 1024 * 1024},
          {"path":"README.md","type":"blob","size":10}
        ]});
        let t = files_in_tree(&tree);
        assert_eq!(t.files.len(), 4, "folders aren't files");
        assert!(!t.truncated);
        let m = models_in(&t);
        assert_eq!(
            m.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["assets/suit.glb", "assets/Helmet.STL"]
        );
        let cut = files_in_tree(&json!({"tree": [], "truncated": true}));
        assert!(cut.truncated);
    }

    #[test]
    fn repo_names_follow_github() {
        assert!(repo_name_ok("Iron-Suit_mk.2"));
        assert!(!repo_name_ok(""));
        assert!(!repo_name_ok(".."));
        assert!(!repo_name_ok("a/b"));
        assert!(!repo_name_ok("has space"));
        assert!(!repo_name_ok(&"a".repeat(101)));
        assert!(session_ok("sesn_011CVabc"));
        assert!(!session_ok("../x"));
    }

    #[test]
    fn repo_paths_stay_inside_the_repo() {
        assert!(path_ok("docs/spec.md"));
        assert!(path_ok("docs/.github/notes.md"));
        for bad in [
            ".github/workflows/ci.yml",
            ".GitHub/dependabot.yml",
            "",
            "/etc/x",
            "docs/",
            "a//b",
            "../x",
            "a/./b",
            ".git/config",
            "a\nb",
        ] {
            assert!(!path_ok(bad), "{bad}");
        }
        assert!(!path_ok(&"a".repeat(MAX_PATH + 1)));
    }

    #[test]
    fn paths_are_encoded_per_segment() {
        assert_eq!(urlencoding("my model.glb"), "my%20model.glb");
        assert_eq!(urlencoding("feature/x"), "feature%2Fx");
    }
}
