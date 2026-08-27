#!/bin/bash
# PostToolUse hook (Write|Edit matcher): auto-fixes lint issues on the file
# just written/edited, but only for client/**/*.ts(x) — that's the only
# place ESLint is configured in this repo (client/eslint.config.js). Files
# outside client/ (backend src/) are no-ops since there's no ESLint config
# there yet. Non-blocking: always exits 0; any lint errors eslint --fix
# couldn't resolve are surfaced back to Claude via
# hookSpecificOutput.additionalContext rather than blocking the edit — the
# edit has already landed by the time PostToolUse fires.
input=$(cat)
file_path=$(jq -r '.tool_input.file_path // empty' <<<"$input")

case "$file_path" in
  */client/*.ts | */client/*.tsx) ;;
  *) exit 0 ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT=$(cd "$REPO_ROOT/client" && npx eslint --fix "$file_path" 2>&1)
STATUS=$?

if [ $STATUS -ne 0 ]; then
  jq -n --arg path "$file_path" --arg output "$OUTPUT" \
    '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: ("eslint --fix left unresolved issues in " + $path + ":\n" + $output)}}'
fi

exit 0
