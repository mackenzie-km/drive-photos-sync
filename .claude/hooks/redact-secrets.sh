#!/bin/bash
# PreToolUse hook (Bash matcher): guardrail against a live-looking secret
# ending up in a shell command before it ever runs. If the command
# contains an sk_live_... pattern (Stripe-style live secret key), the
# match is swapped for a placeholder via hookSpecificOutput.updatedInput
# so the redacted command is what actually executes. If no match is
# found, this is a no-op (exit 0, no output) and the command runs
# unmodified through the normal permission flow.
input=$(cat)
command=$(jq -r '.tool_input.command // empty' <<<"$input")

[ -n "$command" ] || exit 0

PATTERN='sk_live_[A-Za-z0-9]{10,}'

echo "$command" | grep -qE "$PATTERN" || exit 0

redacted=$(echo "$command" | sed -E 's/sk_live_[A-Za-z0-9]{10,}/sk_live_REDACTED/g')

jq --arg cmd "$redacted" '
  .tool_input.command = $cmd |
  {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: .tool_input,
      permissionDecisionReason: "Redacted a live-looking secret (sk_live_...) from the command before execution."
    }
  }
' <<<"$input"

exit 0
