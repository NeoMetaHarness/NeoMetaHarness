# P0-3 Seam spikes: helper brief

The PM is the Claude thread "Design the Neo Meta Harness Architecture". Helper agents do the spikes below; the PM reviews every result and merges what passes into `main`. Read `AGENTS.md`, `docs/02-architecture.md` and `docs/05-extension-system.md` before starting.

## Rules for helper agents
1. **Work only in your own worktree and branch:** Codex → `C:\Users\Neo\Desktop\nmh-wt\codex` (`spike/codex`), Antigravity → `C:\Users\Neo\Desktop\nmh-wt\gemini` (`spike/gemini`). Never edit `C:\Users\Neo\Desktop\Neo-Meta-Harness` (the PM's checkout) or the other helper's worktree.
2. **Upstream source code** goes in `C:\Users\Neo\Desktop\nmh-upstream-cache\<name>@<ref>\`, at the ref in `upstream.lock.json` (see that folder's README). It is read-only and shared. Never patch an engine. If a seam needs a patch, that is a finding, not a fix.
3. **Commit locally on your branch** (small commits, LF line endings). **Never push. No GitHub writes of any kind**, no workflows, no `gh repo`/`gh pr`. Read-only `gh api` calls are fine.
4. Only touch `spikes/<your spike ids>/`. Do **not** edit `docs/`, `machine/`, `upstream/` or root files. The PM owns them. Put proposed doc changes in your spike README.
5. Spike code is throwaway but must **run**. Keep it minimal, no new frameworks. Node ≥ 22 / pnpm (use `pnpm.cmd` in PowerShell), Python via `uv`.
6. Windows: `git config core.longpaths true` is already set in your worktree. Use sparse checkouts for huge repos.
7. Prove claims with evidence: commands you ran and trimmed output. "Should work" is not a result.
8. Stop and report `blocked` instead of working around something that needs a secret, a paid account or a GitHub write.

## Deliverable per spike: `spikes/P0-3<x>-<name>/README.md`
```
# P0-3<x> <name>
Verdict: WORKS | WORKS WITH WORKAROUND | BLOCKED | DOES NOT WORK
Question: <what the architecture assumes>
Pinned ref: <upstream>@<ref>
Seam: <exact files / APIs / endpoints at that ref>
Evidence: <commands + trimmed output>
Risks: <what may break on upstream bumps; size of surface we depend on>
Architecture impact: <keep / change X in docs/02 §N because …>
Contract test idea: <the smallest check that would catch a breaking upstream change>
```
End your chat turn with the report block:
`{"status":"ready|question|blocked|failed","summary":"","changes":"commits on your branch","tests":"what you actually ran","risks":""}`

## Assignments
| Spike | Owner | Question |
|---|---|---|
| **a** T3 headless client | Codex | Can a non-T3 React app drive a T3 **server** (threads, send turn, stream events, approvals) through `packages/contracts` + `packages/client-runtime` at the pinned ref? How private or unstable are those packages? |
| **d** DSH seams | Codex | Can a Neo Cordis plugin, mounted by a profile patch (no DSH edits), register a `computerUse` and a `browserUse` provider? Can Neo drive DSH over the SDK JSON-RPC profile (create session, send prompt, stream events)? |
| **e** Superagent Source + MCP | Codex | Can a Neo bundle add a custom Source kind (cookbook 008) and give worker sessions an extra MCP server through a preset patch, both without editing dsh-superagent? |
| **b** Hermes API coverage | Antigravity | Map the Hermes `api_server` and dashboard-backend endpoints (pinned `v0.23.2`) for bots/profiles, chat/runs streaming, cron, kanban, skills (+ `/learn`, curator), memory providers, platforms/channels, model providers. Table: capability → endpoint → read/write → auth. Run Hermes locally to confirm the core ones. |
| **f** Hermes memory provider | Antigravity | Write a stub Hermes memory-provider plugin (installed by path, no Hermes edits) that serves context from a fake L1 HTTP endpoint and records writes. Prove Hermes calls it. |
| **c** Hermes external screen | Antigravity | Read-only research: how Bot Screen and `computer_use` (cua-driver) pick their display/backend. Can an external computer (a VNC host, Orgo, boat) be plugged in through a plugin or config, without editing Hermes? Cite the files. |
| **g** Astryx in Tauri + PWA | PM | Done by the PM (needs the Rust toolchain). |
