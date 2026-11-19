# Panda model router

Optional Model Hub routing policy. Enable `models` first, configure direct providers and
all required role bindings, then enable `models-router-panda`. A direct binding is
required even for a routed role: it is the fallback if Panda times out, returns an
unknown candidate, has a missing vault credential, or is disabled. Explicit profile
overrides bypass Panda.

## Upstream seam

Consumed unmodified over HTTP at the registry/lock pin
`PandaOrchestrator@83e408c794ef`:

- `panda_router/serve/server.py:30-38`: `GET /health`, `POST /route`.
- `panda_router/serve/router.py:73-86`: request validation and routing.
- `schemas/route_request.schema.json:8-35`: `task` and model-card `pool`.
- `schemas/route_response.schema.json:28-38`: `choice.model_id`.

This pin selects models; it does not proxy OpenAI completions. Neo maps the chosen
card ID to a configured provider/model and executes through the existing direct
OpenAI-compatible provider. Panda cannot supply an endpoint or a credential.

## Configuration

The extension declares `schema/settings.json`. Authenticated oRPC procedures are
`x['models-router-panda'].settings.get/set` (admin/owner), and `.health` (viewer).
Set an existing **default workspace** vault secret using the vault API, then refer
to its name in `vaultSecret`; omit the reference for an unauthenticated local Panda.
Neither the settings nor health response contains the credential. `endpoint` must
be HTTP(S), without embedded credentials, query parameters or fragment. Redirects
are refused. The timeout includes reading the response, which is capped at 64 KiB.

Example settings (all IDs must match your own providers and Panda model cards):

```json
{
  "endpoint": "http://127.0.0.1:8765",
  "vaultSecret": "PANDA_API_KEY",
  "timeoutMs": 1500,
  "roles": {
    "coding": [
      { "modelId": "your-panda-card", "providerId": "your-provider", "model": "your-model" }
    ]
  }
}
```

The five roles are `default`, `fast`, `reasoning`, `coding`, and `eval`. Omitted or
empty role candidate lists use direct resolution. Candidate IDs must be unique per
role. The credential is sent as a Bearer header: the pinned Panda HTTP server has
no built-in authentication, so a protected deployment needs an authenticating
reverse proxy. Use TLS for a remote protected endpoint.

Endpoint health reports `ok: false` for an unconfigured or unreachable service.
The extension remains operational during an endpoint outage because direct
fallback still works. Disable detaches the policy and aborts in-flight requests;
re-enable and Gateway restart reload the persisted metadata and vault reference.

Model Hub currently supplies role/profile metadata rather than task text; requests
therefore classify a role, never forward a user's prompt. This implementation
covers model selection and availability fallback. The architecture's planned
run/verify/outcome/escalation loop is not implemented by this selection hook.

## Verification

`pnpm test:p2-8` builds the App first, then runs the routing hook, fake Panda HTTP
adapter, and authenticated isolated Gateway tests. The integration test executes
fake OpenAI-compatible model calls, checks vault-backed routing for all five roles,
direct fallback, explicit overrides, policy, disable/re-enable, and restart.
No real engine, subscription, or upstream Panda process is started.
