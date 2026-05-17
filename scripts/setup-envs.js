#!/usr/bin/env node
// Cross-platform replacement for the previous `cp -n` shell pipeline used by
// `yarn setup:envs`. The shell version broke on Windows Git Bash because the
// embedded `\n` in the trailing echo was treated as a command separator,
// causing `cp` to receive the echo argument as an extra positional.
//
// fs.copyFileSync with COPYFILE_EXCL is the portable equivalent of `cp -n`:
// it never overwrites an existing destination and surfaces a clean EEXIST
// that we treat as a successful skip.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const pairs = [
  ["frontend/.env.example", "frontend/.env"],
  ["server/.env.example", "server/.env.development"],
  ["collector/.env.example", "collector/.env"],
  ["docker/.env.example", "docker/.env"],
];

let copied = 0;
let skipped = 0;

for (const [from, to] of pairs) {
  const src = path.join(repoRoot, from);
  const dst = path.join(repoRoot, to);

  if (!fs.existsSync(src)) {
    console.warn(`[setup:envs] Source missing, skipping: ${from}`);
    continue;
  }

  try {
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    console.log(`[setup:envs] Copied ${from} -> ${to}`);
    copied++;
  } catch (err) {
    if (err.code === "EEXIST") {
      skipped++;
      continue;
    }
    console.error(`[setup:envs] Failed to copy ${from} -> ${to}:`, err.message);
    process.exit(1);
  }
}

console.log(
  `[setup:envs] Done. ${copied} copied, ${skipped} already existed.`
);
