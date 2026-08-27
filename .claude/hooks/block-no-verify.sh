#!/bin/bash
# PreToolUse hook (Bash matcher): refuses to let Claude run `git commit`
# with --no-verify (or its -n shorthand), since that flag skips the
# pre-commit test/build gate in .git/hooks/pre-commit entirely. This only
# stops Claude Code from doing it — it has no effect on a human typing the
# same command in a terminal.
input=$(cat)
command=$(jq -r '.tool_input.command // empty' <<<"$input")

if echo "$command" | grep -qE '\bgit\s+commit\b' && echo "$command" | grep -qE '(--no-verify|\s-n\b)'; then
  echo "git commit --no-verify is not allowed in this repo — the pre-commit test/build gate must run. Fix the failing build/tests instead of bypassing the hook." >&2
  exit 2
fi

exit 0
