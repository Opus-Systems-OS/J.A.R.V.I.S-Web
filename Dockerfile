# J.A.R.V.I.S. on the web — deployment image. Build context is the repo root.
# .github/workflows/image.yml builds this on every push to main and pushes to
# GHCR; the droplet only ever pulls (1 vCPU / 961 MB cannot build Rust).

# ---- page ----------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- server --------------------------------------------------------------
FROM rust:1-bookworm@sha256:9181b56c2a21ab1d5e73cffe04fc762426d30aa7fac3c91141dd033f49a7fc8b AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY server/Cargo.toml server/Cargo.toml
RUN mkdir -p server/src \
 && echo 'fn main() {}' > server/src/main.rs \
 && echo '' > server/src/lib.rs \
 && cargo build --release -p jarvis-web \
 && rm -rf server/src target/release/deps/jarvis_web-* target/release/deps/libjarvis_web-* \
           target/release/.fingerprint/jarvis-web-*
COPY server/src server/src
RUN cargo build --release -p jarvis-web

# ---- runtime -------------------------------------------------------------
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /src/target/release/jarvis-web /usr/local/bin/jarvis-web
COPY --from=web /web/dist /app/web
# Runs as root on purpose: the Docker named volume for /data is root-owned.
# Iron-Fleet's compose drops every capability (cap_drop: ALL) and sets
# no-new-privileges and a read-only root, so this root can't do much.
ENV RUST_LOG=info,tower_http=info \
    STATIC_DIR=/app/web \
    DATABASE_PATH=/data/jarvis-web.db \
    PORT=8200
EXPOSE 8200
CMD ["jarvis-web", "serve"]
