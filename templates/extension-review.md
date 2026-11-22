# Extension delivery review

## Target
Document extension ID, version, pinned source, owner and Neo API range.

## Contract and safety
Verify manifest settings and permissions, vault handling, workspace scope, gateway route authorization, and any engine projection seam.

## Lifecycle acceptance
Record installation, enable, health, disable, rollback and dependent-extension results using isolated fixtures. A disabled extension must remove its own registrations while siblings remain healthy.

## Evidence
Store exact commands, observed results, tests and open risks with source references. Any policy change belongs in the gateway policy (currently `apps/gateway/src/policy.ts`).
