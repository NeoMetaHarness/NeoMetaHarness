#!/usr/bin/env node
// PreToolUse hook: stop agents from reading, searching or editing files in archive/.
// archive/ holds retired plans and docs kept only as a record. Moving files INTO it
// (git mv / mv) is still allowed so the sweep skill can retire files.
import { readFileSync } from "node:fs";

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0); // never block on a malformed payload
}

const tool = input.tool_name ?? "";
const ti = input.tool_input ?? {};
const ARCHIVE = /(^|[\\/"'\s=])archive([\\/]|$)/i;

const block = (what) => {
  process.stderr.write(
    `Blocked: ${what} is in archive/, which holds retired docs kept only as a record. ` +
      `Don't use it as a source. Work from the current code and docs instead.\n`,
  );
  process.exit(2);
};

if (tool === "Bash" || tool === "PowerShell") {
  const cmd = String(ti.command ?? "");
  // Allow retiring files into the archive.
  const moving = /\b(git\s+mv|mv|Move-Item|move)\b/i.test(cmd);
  if (!moving && ARCHIVE.test(cmd)) block("a shell command touching archive/");
  process.exit(0);
}

// The archive's index may be updated when a file is retired.
const target = String(ti.file_path ?? "");
if (/^(Edit|Write|MultiEdit)$/.test(tool) && /(^|[\\/])archive[\\/]README\.md$/i.test(target)) process.exit(0);

for (const key of ["file_path", "path", "notebook_path", "pattern", "glob"]) {
  const v = ti[key];
  if (typeof v === "string" && ARCHIVE.test(v)) block(`"${v}"`);
}
process.exit(0);
