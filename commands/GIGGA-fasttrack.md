---
description: GIGGA fasttrack — force one-shot handling of a simple request
agent: GIGGA
---

First, set the fasttrack flag so any running GIGGA orchestration knows the
user forced fasttrack (the GIGGA orchestrator consumes and deletes this file
at its next PHASE 1):

```
mkdir -p ~/.config/opencode/GIGGA && touch ~/.config/opencode/GIGGA/fasttrack.flag
```

Then handle the following request YOURSELF in one shot, no subagents, no planning.
If it is genuinely multi-step, say so and suggest using the GIGGA
orchestrator.

$ARGUMENTS
