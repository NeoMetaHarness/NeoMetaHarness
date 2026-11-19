---
name: sweep
description: Find outdated plans, specs, docs, TODO notes and agent instructions that no longer match the code, verify each finding against the code and git history, and report them. Reports only; changes nothing until the user approves. Use when the user says "sweep", "find stale docs", or "check the plans against the code".
---

# Sweep: find stale instructions before they distract an agent

Stale plans and notes steer agents into side quests: chasing bugs that were already fixed, building features that were dropped, or trusting a doc over the code. This skill finds them and **reports**. It never edits, deletes or moves anything until the user approves.

## Ground rules

- **Report, don't fix.** No edits in phases 1–4.
- **Evidence or leave it.** A finding needs proof from the code or git history. "Looks old" is not proof. With no proof, leave the note alone.
- **History before removal.** A note can look stale and still matter (for example "don't remove this or bug X comes back"). Check `git log` for the file and the code it talks about before calling it outdated.
- **Conflicts are not stale.** When a rule or memory disagrees with the code, it may be the code that is wrong. List these as **conflicts for the user to decide**, never as "outdated".
- **Stay out of `archive/`.** It holds retired docs kept only as a record.
- **Don't fix the bugs you find.** List them; that's all.

## Phase 1: inventory

Read the **Plans and status** section of `AGENTS.md` to learn where this repo keeps plans, specs and task status. Then list every source of instructions an agent might read:

1. `AGENTS.md`, `CLAUDE.md`, `README.md`, and every file they import or point to.
2. Plans, specs, roadmaps, ADRs and tickets (see AGENTS.md).
3. `TODO`, `FIXME`, `HACK` and `XXX` comments in code: `git grep -nE "TODO|FIXME|HACK|XXX" -- ':!archive' ':!node_modules'`.
4. Claude memory for this project, if present (`~/.claude/projects/<project>/memory/`). Read-only.

## Phase 2: extract claims

From each source, pull out concrete, checkable claims. Examples:
- "Login supports Google sign-in" (a feature exists)
- "The products page lives at `src/pages/products`" (a path or name)
- "Phase 3 is not started" / "P1-8 is in progress" (a status)
- "TODO: fix the retry bug" (an open problem)
- "Run `pnpm test:x` before pushing" (a command that should exist)

Skip opinions, goals and principles. Only claims about the current state of the repo.

## Phase 3: check each claim

For each claim, look at the code and history:
- Does the file, route, page, function, table, script or command exist under that name?
- `git log --oneline -15 -- <path>` and `git log -S "<identifier>" --oneline` to see when it was added, renamed or removed, and why.
- For TODOs: was the problem fixed later? Look at later commits touching those lines.
- For status: does the code match the status? Done items should exist; not-started items should not be half-built.

Classify each claim:
- **current**: matches the code. Drop it from the report.
- **outdated**: the code or history proves it is no longer true.
- **conflict**: a rule, memory or plan disagrees with the code, and it's unclear which side is right.
- **unclear**: not enough evidence. Drop it from the report.

## Phase 4: independent verification

Give each **outdated** and **conflict** finding to a separate checker that has not seen your reasoning:
- In Claude Code, use the `sweep-verifier` subagent.
- In Codex or elsewhere, spawn a subagent if available; otherwise re-check each finding yourself from scratch, starting from the claim alone.

Pass only the claim, the source file and line, and the repo path. **Do not** pass your conclusion or your evidence, so the checker can't be steered. Keep only findings the checker confirms. Findings it rejects or can't confirm go to "dropped after verification" with one line each.

## Phase 5: report

Reply with:

1. **Outdated** — table: source (`file:line`), the claim, what the code shows (with `file:line` or commit hash), and a suggested action: update the line, mark dropped, or archive the file.
2. **Conflicts for you to decide** — table: the rule or plan, what the code does, and the question to answer.
3. **Open TODOs that are real** — still-open problems, listed only. Not fixed.
4. **Dropped after verification** — one line each.

Then ask which actions to apply.

## Phase 6: apply (only after approval)

Apply exactly what the user approved:
- Update or delete stale lines in place.
- Retire whole files with `git mv <file> archive/<same/path>`, keeping the original folder structure. Add one line to `archive/README.md`: date, file, and why.
- Fix any links in other docs that pointed at moved files.
- Run the repo's checks if it has them (see AGENTS.md). Don't commit unless the user asks.
