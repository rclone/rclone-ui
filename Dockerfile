# syntax=docker/dockerfile:1
# Rclone UI in a browser: rclone-cloud, no GTK/WebKit.
#   docker build -t rclone-cloud .
#   docker run -d -p 5573:5573 -e RCLONE_CLOUD_PASSWORD=change-me \
#     -v rclone-ui:/data -v rclone-ui-config:/config/rclone rclone-cloud
# Sign in as admin@localhost (or RCLONE_CLOUD_EMAIL) with that password; the pair seeds the owner
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
    && cp target/release/rclone-cloud /usr/local/bin/rclone-cloud

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates fuse3 tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=rclone/rclone:latest /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=build /usr/local/bin/rclone-cloud /usr/local/bin/rclone-cloud
ENV RCLONE_CLOUD_BIND=0.0.0.0:5573 \
    RCLONE_CLOUD_DATA_DIR=/data \
    RCLONE_CLOUD_RCLONE_PATH=/usr/local/bin/rclone \
    XDG_CONFIG_HOME=/config
# The server keeps its own state in /data and has no say in where rclone's config lives; rclone
# resolves that itself, and XDG_CONFIG_HOME puts it at /config/rclone/rclone.conf — the same
# layout rclone's own image uses, so `-v ~/.config/rclone:/config/rclone` shares a host config.
VOLUME /data
VOLUME /config/rclone
EXPOSE 5573
ENTRYPOINT ["tini", "--", "rclone-cloud", "serve"]
