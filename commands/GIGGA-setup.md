---
description: GIGGA first-run setup — map model tiers and write GIGGA.config.json
agent: GIGGA-config
subtask: true
---

Run the GIGGA setup wizard: determine my current model (from
~/.config/opencode/GIGGA/last-model.json, falling back to the "model" key in
opencode.json/opencode.jsonc), propose it for ALL tiers (low/medium/high)
with defaults (defaultTier medium, maxParallel 5, autoRetry off, sound on,
questionRounds 2), ask me ONE batched confirm via the `question` tool (use it
for everything / customize), then write ~/.config/opencode/GIGGA/GIGGA.config.json and update
the `model:` lines in the GIGGA agent files (the worker files carry the
`<!-- set by GIGGA-config -->` marker). Use the `question` tool for every
question — never type questions as plain text. Only if I choose "customize",
batch the per-tier model picks and the individual settings into ONE more
`question` tool call.
