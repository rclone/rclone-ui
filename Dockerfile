# syntax=docker/dockerfile:1
# Rclone UI in a browser: rclone-ui-server, no GTK/WebKit.
#   docker build -t rclone-ui-server .
#   docker run -d -p 5573:5573 -e RCLONE_UI_PASSWORD=change-me -v rclone-ui:/data rclone-ui-server
# Sign in as admin@localhost (or RCLONE_UI_EMAIL) with that password; the pair seeds the owner
# account on the first start and is ignored once accounts exist (Settings › Team).
# Mounts need FUSE: add --device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor:unconfined
# and a bind mount with `:rshared` propagation for the mount point to show up on the host.

FROM node:22-bookworm AS web
WORKDIR /app
# The manifests first, so a source-only change reuses the installed layer.
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm --prefix frontend ci
COPY frontend ./frontend
RUN npm --prefix frontend run build

FROM rust:1-bookworm AS build
WORKDIR /app
# Nothing here needs GTK or WebKit: the server links neither.
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY --from=web /app/frontend/dist ./frontend/dist
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release \
    && cp target/release/rclone-ui-server /usr/local/bin/rclone-ui-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates fuse3 tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=rclone/rclone:latest /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=build /usr/local/bin/rclone-ui-server /usr/local/bin/rclone-ui-server
ENV RCLONE_UI_BIND=0.0.0.0:5573 \
    RCLONE_UI_DATA_DIR=/data \
    RCLONE_UI_RCLONE_PATH=/usr/local/bin/rclone
VOLUME /data
EXPOSE 5573
ENTRYPOINT ["tini", "--", "rclone-ui-server", "serve"]
