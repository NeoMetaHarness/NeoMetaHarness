# Honcho L2 feasibility (pinned plastic-labs/honcho v3.6.1)
Honcho v3.6.1 requires PostgreSQL with pgvector and a model provider key (LLM_OPENAI_API_KEY or equivalent). Embeddings default to text-embedding-3-small (upstream README.md:375-446).
Honcho REST v3 works with a separate deriver worker for asynchronous insights (upstream README.md:575).
This Windows machine has uv but no docker, postgres or psql command available. Isolated full Honcho cannot be proven here without installing infrastructure.
P4-5 uses a fake server in test/ implementing only the called v3 router endpoints, each cited to upstream src/routers/*.py lines.
