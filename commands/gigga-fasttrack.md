---
description: GIGGA fasttrack — force one-shot handling of a simple request
agent: gigga-fasttrack
---

First, set the fasttrack flag so any running GIGGA orchestration knows the
user forced fasttrack (the gigga orchestrator consumes and deletes this file
at its next PHASE 1):

```
mkdir -p ~/.config/opencode/gigga && touch ~/.config/opencode/gigga/fasttrack.flag
```

Then handle the following request in one shot, no subagents, no planning.
If it is genuinely multi-step, say so and suggest using the gigga
orchestrator.

$ARGUMENTS
