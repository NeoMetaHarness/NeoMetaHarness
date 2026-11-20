# Honcho L2 feasibility (pinned plastic-labs/honcho v3.6.1)
Honcho v3.6.1 requires PostgreSQL with pgvector and a model provider key (LLM_OPENAI_API_KEY or equivalent). Embeddings default to text-embedding-3-small (upstream README.md:375-446).
Honcho REST v3 works with a separate deriver worker for asynchronous insights (upstream README.md:575).
This Windows machine has uv but no docker, postgres or psql command available. Isolated full Honcho cannot be proven here without installing infrastructure.
P4-5 uses a fake server in test/ implementing only the called v3 router endpoints, each cited to upstream src/routers/*.py lines.

## Dreaming (P4-9)
A consolidation pass over L1 (`memory-local`'s `memoryStore`) and L2 (Honcho, through the REST v3 seam only; Honcho itself is never modified).
- Runs nightly for the `default` workspace, and on demand through `x.memory-honcho.dream.run` (member). `dream.last` is viewer.
- Proposes: `dedupe` (keeps the most trusted, then the oldest copy), `retract` (untrusted candidates older than 30 days that nothing corroborates), `promote` (observed facts seen twice in L1 or independently in Honcho), `sync-l2` (confirmed L1 facts missing from Honcho) and `sync-l1` (Honcho facts missing from L1, entering as observed at most). Turn records are never touched, and a synced copy never corroborates its own origin.
- Writes `DREAMS.md` under the extension data directory and hands the report to the Inbox (`engine-superagent`'s `memoryInboxSink`). Accept mode `act` applies non-destructive dreams at once. Otherwise `observe` makes a Suggestion and `act-with-approval` an approval. Deletions (`dedupe`, `retract`) always need an admin.
- Applying re-checks each target and skips anything that changed since the dream. With the Inbox disabled, a dream is reported as `undelivered` and nothing is written.

Standing intents live in L1 (`memory-local`, source `neo.intent`) so they keep working without Honcho. See `x.memory-local.intents.*`.

Review hardening (P4-9):
- Dreams never touch standing intents. Honcho metadata is never trusted: imports enter L1 as observed at most, and an L2 entry claiming to be an intent is ignored. Corroboration must match the subject as well as the text.
- A dream follows its own workspace's accept mode. In server mode every memory route refuses a workspace other than the caller's.
- Retracting an intent also deletes any Honcho copy.
- Honcho lists are paged fully, and apply re-checks both stores before every write, so read windows never cause duplicate writes.
- Pending dreams are never pruned. Reject waits behind a running apply. A dream interrupted mid-apply is offered again after a restart. A corrupt `dreams.json` is logged and ignored.
- The nightly timer is anchored to the last dream, and a dream with no L1 proposes no imports.
