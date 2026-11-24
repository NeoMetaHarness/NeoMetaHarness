# Interactive replies

Enable **Interactive agent replies** in Extensions. In Agents, select a Hermes bot and check **Interactive replies** before sending a prompt. In Coding, check it when creating a thread. Ask for a small form, a checklist, or a choice you can submit.

The agent decides when a reply needs a surface. Neo can render headings, text, grouped content, labeled text fields, checkboxes, and buttons. Submitting a control sends its named fields as a user message in the same Hermes session or T3 thread. Engine tool approvals follow the usual chat flow.

Controls belong to the conversation member who requested the reply and expire after 30 minutes. Earlier replies can still show their content with inactive controls. Existing T3 threads without a Neo conversation binding continue to show plain text.

Disabling the extension restores the original assistant text. Hermes conversations that used an interactive reply keep their session for further messages in the open chat. The renderer leaves Markdown links as text and omits remote media.

## Local development

Run `pnpm test:p7-19` to exercise both chat paths with scripted engines, a temporary Gateway database, and an isolated browser profile. The source pin and build details are in the [P7-19 design note](p7-19-a2ui-design.md). Use `node scripts/build-a2ui.mjs` to rebuild the local package archives from the verified fork. Pass a path to the pinned source tarball to use an existing download.
