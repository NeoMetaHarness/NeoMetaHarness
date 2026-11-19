# Self-host Neo with Docker Compose

This layout targets **Linux Docker Engine with Compose v2**. It starts Gateway
and a one-shot Hermes preparation service. The optional `memory` profile adds
Honcho, its deriver, and PostgreSQL with pgvector. Nothing starts a real model job
during preparation. Model credentials are configured later through Neo's vault.

Gateway currently binds to `127.0.0.1` in
[server.ts](../../apps/gateway/src/server.ts), with no configurable listen address.
The Gateway container therefore uses Linux host networking: the API is reachable
on the host's loopback port 8787. There is no published Gateway port to accidentally
expose. Plain bridge networking plus `ports` cannot reach this loopback listener.
Use a Linux VM on Windows/macOS; this recipe does not assume Docker Desktop host
networking is enabled. Host networking shares the host's network namespace, so run
only trusted extensions and keep the host firewall configured appropriately.

Hermes is **not** a separately hosted remote API here. Neo's current
[adapter](../../extensions/engine-hermes/src/runtime.ts) launches local Python
subprocesses through [bridge.py](../../extensions/engine-hermes/src/bridge.py).
The `hermes` initialization container clones the exact ref from
[upstream.lock.json](../../upstream.lock.json), verifies an untouched checkout,
and installs frozen dependencies into shared volumes. Gateway uses those same
paths and owns all Hermes process lifetimes. No engine source is patched, and
the user's own Hermes/T3 homes are never mounted.

At the pinned Hermes `v0.23.2` ref, the consumed API adapter is
[gateway/platforms/api_server.py:1034](https://github.com/NousResearch/hermes-agent/blob/v0.23.2/gateway/platforms/api_server.py#L1034).
The installed extras are declared in `pyproject.toml` at
[telegram:346](https://github.com/NousResearch/hermes-agent/blob/v0.23.2/pyproject.toml#L346),
[sms:438](https://github.com/NousResearch/hermes-agent/blob/v0.23.2/pyproject.toml#L438),
and [web:525](https://github.com/NousResearch/hermes-agent/blob/v0.23.2/pyproject.toml#L525).

## Prepare local files

Run these commands from the repository root on the Linux host:

```sh
mkdir -p deploy/secrets
chmod 700 deploy/config deploy/secrets
for name in compose gateway hermes honcho postgres; do
  cp "deploy/config/$name.env.example" "deploy/config/$name.env"
done
chmod 600 deploy/config/*.env
pnpm deploy:check
```

Edit the private files before use. Compose takes service environment variables
from these files, not inline YAML. The Compose CLI's image substitutions come
from `compose.env`; service `env_file` settings do not supply CLI interpolation.
Actual `.env` files and the secrets directory are ignored by Git and excluded
from the image build context. Templates contain no credentials. Keep other
private files outside the repository/build context too.

`gateway.env` selects server authentication, a stable port, and managed data
paths. Leave auth signing secrets unset: Gateway generates and persists
`auth.secret` in its data volume. The vault creates its own private master key
there. Do not set desktop mode or print desktop tokens on a shared deployment.

## Build and start Gateway with Hermes

```sh
docker compose --env-file deploy/config/compose.env -f deploy/docker-compose.yml build hermes
docker compose --env-file deploy/config/compose.env -f deploy/docker-compose.yml up -d gateway
docker compose --env-file deploy/config/compose.env -f deploy/docker-compose.yml logs hermes gateway
```

The first build downloads pinned npm dependencies and Python; Hermes preparation
downloads the pinned engine and its frozen Python dependencies. No engine is
enabled automatically. Preparation must complete before Gateway starts; a
checkout mismatch or dependency failure stops startup rather than using another
engine version. `HERMES_PREPARED` and `GATEWAY_READY` are the expected log markers.

Create the owner account and organization using Neo's authenticated application
or its `/auth/sign-up/email`, `/auth/sign-in/email`, and
`/auth/organization/create` endpoints. Keep request bodies and bearer headers in
private files rather than shell history. Enable `engine-hermes` through Extensions
after configuring model access in the vault. This Compose file serves the Gateway
API, not static App assets: host a built Neo App separately, or point an existing
App at this Gateway. `pnpm --dir apps/neo-app build` produces the static App.

## Reverse proxy and allowed hosts

Keep Gateway on loopback. Run a TLS reverse proxy on the same Linux host and set
`NEO_ALLOWED_HOSTS` in the private `gateway.env` to the exact external Host header:

```dotenv
NEO_ALLOWED_HOSTS=neo.example.org
```

For multiple hosts use commas. Include a non-default port when present, such as
`neo.example.org:8443`; do not add a scheme, path or wildcard. If App and API have
different public hosts, include the App host too so its browser Origin is allowed.
Gateway checks both Host and Origin; this setting does not authenticate callers
or trust arbitrary forwarded identity headers. Without an allowlisted external
Host, the proxy request is rejected with 421; disallowed browser Origins get 403.

For example, on-host Caddy can preserve Host, terminate TLS and forward WebSockets
and streaming HTTP without changing the Gateway listener:

```caddy
neo.example.org {
  reverse_proxy 127.0.0.1:8787 {
    flush_interval -1
  }
}
```

Recreate Gateway after editing its environment file. Do not expose port 8787
directly on a public interface or publish database/engine ports.

## Optional Honcho and pgvector

The Neo runtime image does not include Honcho. Build its image from the exact
unmodified upstream ref **outside this repository**, then use the local tag in
`compose.env`:

```sh
git clone --depth 1 --branch v3.6.1 https://github.com/plastic-labs/honcho.git /opt/neo-honcho-source
docker build -t neo-honcho:v3.6.1 /opt/neo-honcho-source
```

Before enabling `memory`:

- Write a generated PostgreSQL password to the private
  `deploy/secrets/postgres-password` file (mode 0600, no trailing newline).
  `postgres.env` references that file through `POSTGRES_PASSWORD_FILE`.
- Privately fill `DB_CONNECTION_URI` in `honcho.env` using the same password,
  user `neo`, database `honcho`, and Compose hostname `postgres:5432`. The required
  driver scheme is `postgresql+psycopg`; percent-encode the password in the URI.
- Set a generated `AUTH_JWT_SECRET` and the model-provider credentials required
  by your Honcho configuration in `honcho.env`. Keep `AUTH_USE_AUTH=true`.
  Configure provider/model choices using the pinned upstream settings; the sample
  key name is only an example of a supported provider.

```sh
docker compose --env-file deploy/config/compose.env -f deploy/docker-compose.yml --profile memory up -d
```

Honcho's API is published only at `127.0.0.1:8000`; PostgreSQL has no published
port. API and deriver use the same private configuration. Cache is disabled, so
Redis is not required. The upstream API entrypoint provisions the database;
the deriver waits for the API health check. These are the pinned seams:
[upstream compose](https://github.com/plastic-labs/honcho/blob/v3.6.1/docker-compose.yml.example),
[entrypoint](https://github.com/plastic-labs/honcho/blob/v3.6.1/docker/entrypoint.sh),
and [settings](https://github.com/plastic-labs/honcho/blob/v3.6.1/src/config.py).

Issue a bearer JWT using Honcho's supported authentication tooling/settings. Store
it as workspace-scoped `HONCHO_API_KEY` in Neo's vault and store
`HONCHO_URL=http://127.0.0.1:8000` in the same scope. Then enable `memory-honcho`.
The [Neo REST adapter](../../extensions/memory-honcho/src/store.ts) reads those
vault records; it does not read a Compose environment API key. Turning off the
optional services leaves Gateway, Hermes and local memory usable. To stop an
already running memory profile, explicitly stop `honcho`, `honcho-deriver` and
`postgres`; omitting `--profile memory` from a later `up` does not stop them.

## State, upgrades and checks

| Named volume | Contents |
| --- | --- |
| `neo-data` | SQLite, auth signing secret, vault key and encrypted records, extension data |
| `hermes-home` | Neo-owned Hermes profiles and state |
| `hermes-cache` | Frozen Hermes Python environment and dependency cache |
| `upstream-cache` | Pinned, unmodified engine source; read-only in Gateway |
| `honcho-postgres` | Optional persistent Honcho database and vectors |

Volume names are prefixed by Compose project `neo-selfhost`. The Hermes home and
source/cache volumes are nested mounts and need separate backup coverage;
copying only `neo-data` is insufficient. Use a SQLite-aware backup for the live
Neo database, keep the vault master key separately protected, and use PostgreSQL
backup tooling for Honcho. `docker compose down` preserves named volumes;
`down -v` destroys them and is not an upgrade command.

For an upgrade, back up first, review the registry/lock ref changes, rebuild
Hermes, rerun its preparation service, and recreate Gateway. Do not change engine
tags independently of the lock. Database restores and rollback compatibility
must be checked before replacing a deployment.

`pnpm deploy:check` validates the bundled Compose JSON Schema and checks explicit
loopback publishing, environment files, optional profiles and common inline
credential forms. Its negative tests use in-memory mutations and fake subprocesses
only. It does not read private env files, pull images, run Docker, contact model
providers, prove image availability or claim that a deployment booted.
