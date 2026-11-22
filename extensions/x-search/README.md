During a blue/green upgrade, while the old JSON quota generation drains, total usage can briefly exceed a limit until its final charges are reconciled into SQLite.

During migration of legacy multi-workspace JSON quotas, unattributable user counters are charged conservatively to every workspace the authenticated member accesses. This can temporarily overcount until the old daily window expires.
