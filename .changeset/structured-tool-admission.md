---
"@howaboua/pi-codex-conversion": patch
---

Keep the selected Pi tools available when switching away from a Structured Codex model after `/reload`, or when resuming or navigating a branch that recorded those selections. GPT still sees the Structured tools in place of `read`, `bash`, `edit`, and `write`. The adapter does not re-enable tools Pi did not admit.
