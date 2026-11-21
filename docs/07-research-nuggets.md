# 07 · Research notes: PandaCode family

Status: 2026-11-17 · repos reviewed: [PandaCode](https://github.com/aicodeking/pandacode), [PandaOrchestrator](https://github.com/aicodeking/PandaOrchestrator), [PandaOS](https://github.com/aicodeking/pandaos), [dsh-superagent-gui](https://github.com/aicodeking/dsh-superagent-gui)

The rule from Architecture §0 applies: we use **protocols and processes**, not copied code. Panda Router is consumed as an unmodified process (MIT). From the others we take ideas.

## 1. PandaOrchestrator (Panda Router): adopt as an engine

**What it is:** a local model picker.
1. A 31 MB int8 ONNX profiler reads the task and outputs category, difficulty, required skills and flags.
2. A calibrated success head turns that profile into P(success) per model.
3. A deterministic policy scores about 65 JSON **model cards** (skills, price, context, latency).

It returns a `choice`, a ranking and an **escalation ladder** in about 10–25 ms on CPU. Interfaces: HTTP, CLI, Python, **MCP** (`route_task`, `escalate_task`, `record_outcome`, `list_models`), plus SQLite outcome logging with `trace_id` and `propensity`. MIT.

**Evidence (held-out, 9 models):**

| Strategy | Success / 100 tasks | $ / 100 tasks |
|---|---:|---:|
| Single pick | 77.3 | 0.99 |
| Escalate from the choice, ≤ 2 attempts | 90.7 | 1.68 |
| Always the strongest model | 79.3 | 1.11 |
| Oracle (best possible pick) | 94.0 | 0.56 |

Training cost almost nothing: $1.67 on Modal for v4.

**Use in Neo:**
- `models-router-panda` extension (cordis in-process, oRPC/MCP): the **default model picker** for every turn. Pools come from the Model Hub, and cards are extended with the user's subscriptions and local models.
- **Route → run → verify → record outcome → escalate on failure** becomes Neo's standard execution loop. Verification sources:
  - turn checks (tests, typecheck);
  - the report contract (§3);
  - human approval or rejection.
- Log decisions in Panda-compatible form (`trace_id`, `propensity`, `explored`), so that off-policy evaluation and retraining work later.
- **P8:** retrain the success head on Neo's own outcomes. Extend the same architecture (small encoder profiler + heads + deterministic policy) with Neo heads for **delegation** (self / coding / bot / human). Reuse its methodology: attempt-and-grade, judge agreement (kappa), gold set, calibration (ECE).

## 2. PandaOS: computer providers and a safety baseline

**What it is:** an agent-first NixOS that turns any PC into an agent box. Pre-release, VM-tested.
- `agent` user with no sudo.
- **One cgroup per agent task** (runaway tasks die alone).
- `panda-ckpt` checkpoints + hourly btrfs snapshots.
- `/mem`: git-backed shared memory with an **episode log**.
- **MCP registry** (`/etc/panda/mcp.d`) synced into every agent CLI.
- `panda-cu`: computer use over MCP, **headless private session by default, attach to your session optional**. In attach mode: AGENT badge, Super+Esc kill switch, clipboard reads refused.
- Self-updates with rollback.
- `boat`: self-hosted Firecracker microVM sandboxes with a **boat.dev-compatible API** (fork, snapshot, stop/resume, port URLs, browser desktop, secrets, quotas).

**Use in Neo:**
- New computer providers:
  - `computer-boat` (one provider for boat.dev cloud **and** self-hosted PandaOS boat, through the same API; fork and snapshot are useful for parallel agent attempts);
  - `computer-pandaos` (an old PC as a dedicated agent box, through `panda-cu` MCP + SSH).
- **Computer safety baseline** for every provider:
  - headless and private by default; attaching to a person's screen is opt-in;
  - a visible "agent is acting" indicator plus a global kill switch;
  - clipboard read off in attach mode;
  - a separate OS user where possible;
  - resource isolation per task;
  - a checkpoint before risky runs.
- **MCP projection:** the Neo Tools registry syncs MCP servers into every engine and agent CLI (Hermes, DSH, Claude Code/Codex through T3), the way PandaOS's `mcp.d` does.
- **Episodes** in L1 memory: task-level records (goal, attempts, models, outcome, lessons). This is what the skills fabric and the router learn from, with a git-backed export.
- Benchmarks with budgets (METRIC lines → collect → compare against budgets) for `neo check`. Its `cubench` is a model for scoring computer providers.
- Later (P9): PandaOS as a reference OS for an always-on Neo node.

## 3. dsh-superagent-gui: super agent UX and contracts

**What it is:** a zero-dependency Node port of dsh-superagent. Point it at **any folder** (git or not), type a request; an agent CLI works in a private **worktree or copy**; you review the result, then Merge / Apply / open a PR. MIT.

**Use in Neo (ideas only; we keep the upstream bundle):**
- **Report contract** for every executor (coding threads, bots, DSH workers):
  ```json
  {"status":"ready|question|blocked|failed|dropped","summary":"","question":"","options":[],"changes":"","tests":"what was actually run","risks":""}
  ```
  It drives the Inbox, verification, escalation, Panda `record_outcome` and training labels uniformly. A matching **assessment contract** covers Eval.
- **Accept modes per workspace: `observe` (default), `act-with-approval`, and `act`.** In `observe`, inferred work becomes a **Suggestion** a person starts or dismisses. `act-with-approval` stages actions for approval, while `act` executes autonomous actions directly.
- **New Sources:** `@agent` / `@neo` comments in code (git grep), and **failing checks** (periodic check command) as triggers.
- **Ticket stages** (first match wins): answer → review → blocked → failed → queued → working → ended. These become the Inbox lanes. Worker slots reserve one extra slot for runs a person starts.
- **An honest autonomy matrix:** "careful" mode maps to what each CLI can really enforce. Claude Code permissions and the Codex OS sandbox can restrict; others can't. The App shows this truthfully when you pick an executor and an autonomy level.
- **Safety details:** never run a project's own git hooks, filters or helpers; worktree-or-copy for non-git folders; changes reach your folder only on explicit Merge/Apply; localhost binding + Host-header check + token cookie.

## 4. Impact on the Tauri ADR
None. PandaOS and the GUI use web UIs or the PandaCode AppImage and give no reason to prefer Electron. ADR 0001 stands.
