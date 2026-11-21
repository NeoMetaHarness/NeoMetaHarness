# First-Time Onboarding Experience

Neo Meta Harness provides a guided, 15-minute onboarding experience inside the Astryx desktop shell (`apps/neo-app/src/pages/Onboarding.tsx`, `docs/04-roadmap.md:77`). The onboarding wizard bootstraps the initial workspace, configures model access, provisions the first bot, and verifies end-to-end communication before opening the main interface.

## Five-stage onboarding flow

The wizard guides administrators through five structured steps:

### Stage 1: Workspace and owner verification

- **Source:** `apps/neo-app/src/pages/Onboarding.tsx:210-215`
- **Endpoint:** `api.onboarding.get()` (`packages/contracts/src/index.ts:28-29`, `apps/gateway/src/server.ts:980-995`).
- **Function:** Inspects the current deployment to display the default workspace name and owner identity. In standalone desktop mode, the local operator is automatically authenticated as the workspace owner.

### Stage 2: Model provider and role configuration

- **Source:** `apps/neo-app/src/pages/Onboarding.tsx:216-247`
- **Extension activation:** Automatically ensures the `models` extension is enabled via `api.extensions.enable({ id: 'models' })`.
- **Provider registration:** Operators can select an existing provider or add a new OpenAI-compatible, Anthropic, or local provider via `api.x.models.providers.put({ id, name, kind: 'openai-compatible', baseUrl, apiKey })`.
- **Default model assignment:** Sets the primary model role via `api.x.models.roles.set({ role: 'default', providerId, model })`, ensuring all newly created bots have a functioning model backend.

### Stage 3: First bot creation

- **Source:** `apps/neo-app/src/pages/Onboarding.tsx:248-254`
- **Endpoint:** `api.x['engine-hermes'].profiles.create({ name: botName })`.
- **Function:** Provisions the workspace's first conversational bot agent via Hermes engine. The newly created bot automatically inherits the default model configured in Stage 2.

### Stage 4: Channel connection (optional)

- **Source:** `apps/neo-app/src/pages/Onboarding.tsx:255-261`
- **Function:** Presents options to connect external messaging platforms (such as Telegram or WhatsApp) via `/settings/channels`, or continue directly to local testing.
- **Non-blocking:** External channel configuration is optional and can be set up at any later point from the Settings page.

### Stage 5: First interactive test chat

- **Source:** `apps/neo-app/src/pages/Onboarding.tsx:262-273`
- **Endpoint:** `api.x['engine-hermes'].runs.start({ profile: createdBot, input })` and WebSocket event streaming on `/ws` (`stream.x['engine-hermes'].runs.events`).
- **Function:** Prompts the operator to send an introductory test message to the newly created bot. The UI displays the streaming response in real time, confirming that the model provider, Gateway, and agent runtime are functioning correctly.
- **Completion:** Clicking **Finish setup** invokes `api.onboarding.complete()`, transitioning the user into the full Astryx desktop workspace.

## Time tracking and performance budget

To ensure onboarding completes in under 15 minutes:

- **Elapsed timer:** The header displays an elapsed time counter (`formatTime(now - startedAt.current)`).
- **Stage benchmarks:** The wizard records duration per stage (`stepTimes`) to detect bottlenecks during provider verification or initial downloads.
- **Skip option:** Administrators can click **Skip setup for now** (`apps/neo-app/src/pages/Onboarding.tsx:275`) at any stage to access the desktop shell immediately.
