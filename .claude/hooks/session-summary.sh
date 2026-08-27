#!/bin/bash
# SessionStart hook (compact matcher): fires right after Claude Code
# compacts a long conversation, when file-level detail from earlier in the
# session is most likely to have been dropped. Scans this session's own
# transcript for Edit/Write/NotebookEdit tool calls and surfaces the
# deduped file list back into context (plus prints it for the user), so
# "which files have I been touching" survives the compaction even though
# the prose summary doesn't reliably preserve it.
input=$(cat)
transcript=$(jq -r '.transcript_path // empty' <<<"$input")
cwd=$(jq -r '.cwd // empty' <<<"$input")

[ -f "$transcript" ] || exit 0

files=$(jq -r '
  select(.type == "assistant") |
  .message.content[]? |
  select(.type == "tool_use") |
  select(.name == "Edit" or .name == "Write" or .name == "NotebookEdit") |
  (.input.file_path // .input.notebook_path // empty)
' "$transcript" 2>/dev/null | awk -v cwd="$cwd/" '
  { line = $0
    if (index(line, cwd) == 1) line = substr(line, length(cwd) + 1)
    if (!seen[line]++) print line
  }' | tail -n 15)

[ -n "$files" ] || exit 0

summary=$(printf 'Files touched so far this session (most recent last):\n%s' "$files")

jq -n --arg ctx "$summary" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}, systemMessage: $ctx}'

exit 0
