//! `jarvis-web`: `serve` (default) runs the site; `hash-password` prints the
//! Argon2id hash for `JARVIS_WEB_PASSWORD_HASH` — the password itself is read
//! from the terminal and never stored anywhere.

use clap::{Parser, Subcommand};
use jarvis_web::config::Config;
use jarvis_web::{auth, db, error, AppState};
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "jarvis-web", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the site (default).
    Serve,
    /// Read the unlock password from the terminal and print its hash.
    HashPassword,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info")),
        )
        .with_target(false)
        .init();

    if let Err(e) = run().await {
        tracing::error!(error = %e, "fatal");
        std::process::exit(1);
    }
}

async fn run() -> error::Result<()> {
    let cli = Cli::parse();
    if let Some(Command::HashPassword) = cli.command {
        println!("{}", auth::hash_password_interactive()?);
        return Ok(());
    }

    let cfg = Config::from_env()?;
    let db = db::Db::open(&cfg.database_path)?;
    let port = cfg.port;
    tracing::info!(config = ?cfg, "starting");
    let app = jarvis_web::app(AppState::new(cfg, db)?);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| error::Error::Config(format!("bind :{port}: {e}")))?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await
        .map_err(|e| error::Error::Internal(format!("serve: {e}")))
}

/// Ctrl-C locally, SIGTERM from `docker compose` on the droplet.
async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}
