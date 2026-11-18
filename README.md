# Neo Meta Harness

**One open-source product. An always-on super agent knows you, runs a team of agents on any computer, through any channel, with any model, and learns new skills over time. Everything is an extension.**

Built on giants:
- **Backends:** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) + [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype), and [Hermes Agent](https://github.com/NousResearch/hermes-agent).
- **Usability:** [T3 Code](https://github.com/pingdotgg/t3code) and [bot-hq](https://github.com/nickvasilescu/bot-hq) (adopted).
- **Memory:** [Honcho](https://github.com/plastic-labs/honcho) + Hermes-Agents-Local-Memory.
- **Design:** one design system for everything, [Astryx](https://github.com/meta/astryx).

## Docs
1. [Project map](docs/01-project-map.md): what each upstream provides, overlaps, bot-hq gaps
2. [Architecture](docs/02-architecture.md): principles, gateway, engines, computers, skills, memory, channels, models, coding, super agent, topologies, upstream strategy
3. [PRD](docs/03-PRD.md): vision, requirements, metrics, risks
4. [Roadmap](docs/04-roadmap.md): P0–P7 to v1.0, then P8–P9
5. [Extension system](docs/05-extension-system.md): manifest, lifecycle, contribution points
6. [ADR 0001: desktop shell (Tauri 2)](docs/adr/0001-desktop-shell.md)
7. [Org structure](docs/06-org-structure.md): NeoMetaHarness GitHub org, BrowserHarness-style
8. [Research notes: PandaCode family](docs/07-research-nuggets.md)
9. [Encrypted backup and restore](docs/17-backup-restore.md): archive inventory, separate vault key custody, CLI and recovery procedure
9. [Upstream registry](upstream/registry.yaml)
10. [Self-host with Docker Compose](docs/deploy/docker-compose.md)

## Working in this repo
- Agent rules: [AGENTS.md](AGENTS.md) · GitHub policy: [guardrails](docs/policies/GITHUB-SAFETY-GUARDRAILS.md) · ADRs: [docs/adr](docs/adr/README.md)
- `pnpm install` then `pnpm check` (local check pipeline; no CI by policy)
- `pnpm upstream:check`: upstream drift against [upstream.lock.json](upstream.lock.json) (read-only)
- `pnpm org:scaffold --out ../NeoMetaHarness-org`: generate the org repos from [machine/repositories.json](machine/repositories.json)

Original concept map: [Neo-Meta-Harness.png](Neo-Meta-Harness.png)
