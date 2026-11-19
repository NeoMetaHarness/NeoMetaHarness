FROM ghcr.io/astral-sh/uv:0.9.9 AS uv
FROM node:24.22.3-bookworm-slim
COPY --from=uv /uv /uvx /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential \
    && rm -rf /var/lib/apt/lists/*
ENV UV_PYTHON_INSTALL_DIR=/opt/python
RUN uv python install 3.14 && corepack enable && corepack prepare pnpm@12.9.1 --activate
WORKDIR /opt/neo
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile --config.strictDepBuilds=false \
    && mkdir -p /var/lib/neo/upstream /var/lib/neo/hermes /opt/neo/extensions/engine-hermes/.cache \
    && chown -R node:node /var/lib/neo /opt/neo/extensions/engine-hermes/.cache
USER node
