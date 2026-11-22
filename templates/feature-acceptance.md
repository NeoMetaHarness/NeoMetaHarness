# Feature acceptance record

## Request and scope
State the user-visible goal, roadmap task ID, owning repo and source version.

## Normal flow
List entry point, supported inputs, expected outcome, and how to verify the result.

## Boundaries
Test role authorization, workspace scope, failure and retry behavior, extension-off state, and existing callers. Keep hot streamed data out of React state.

## Test evidence
Record local command, exit status, fixture isolation, build version and a concise summary of what passed.

## Handoff
Link the commit and identify any remaining blocker and the exact next action. List any out-of-scope bugs, drift or TODOs you noticed; do not fix them in this task. `machine/readiness.json` changes only from verified evidence.
