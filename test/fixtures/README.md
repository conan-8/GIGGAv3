# Demo fixture repo

Tiny multi-file project used for GIGGA end-to-end tests:
- src/calc.ts, src/greet.ts (TypeScript)
- lib/util.js (CommonJS)

Typical test tasks: "add a multiply function", "convert lib/ to ESM",
"what does slugify do?" (fasttrack candidate).

Parsers (no input validation — the typical E2E task adds it):
- lib/parser.js — parseConfig(text) → object from key=value lines
- src/argv-parser.ts — parseArgs(argv) → object from --key value args
