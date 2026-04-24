---
name: tudu-setup
description: Configure the Tudu ↔ Claude Code integration so Claude's TodoWrite calls auto-sync into a Tudu list (a Markdown file in the user's vault). Invoke when the user asks to install, set up, configure, or wire up Tudu, the Tudu hook, or the Claude-to-Tudu TodoWrite sync.
---

# Tudu setup

Your job: help the user wire `hooks/claude-tudu-hook.py` from the Tudu repo into their `~/.claude/settings.json` as a `PostToolUse` hook matching `TodoWrite`, so every session's todos mirror into a Markdown list file in their vault.

Keep this interaction short. Ask only what you need to. Do the edits for them; show a diff before writing.

## Step-by-step

### 1. Check prerequisites

- Verify `~/Library/Application Support/tudu/config.json` exists (it's created the first time the user runs Tudu). If it doesn't, tell them to launch Tudu once and pick a vault folder in Settings, then come back. Do **not** proceed without it.
- Read `vault_folder` out of that JSON. If missing, same message.

### 2. Find the hook script

Ask the user for the absolute path to the Tudu repo clone (or infer from context — if this skill is being run from a Claude Code session whose `cwd` is the repo, use that).

The hook is at `<repo>/hooks/claude-tudu-hook.py`. Verify the file exists and is executable (`ls -la`). If not executable, `chmod +x` it.

### 3. Pick a list name

Ask the user which list they want Claude's todos written to. Default is `todo` → writes to `<vault_folder>/todo.md`. Offer to list existing `.md` files in the vault folder so they can pick one, or name a new one.

If they choose a non-default name, the hook will be registered with `TUDU_CLAUDE_LIST=<name>` as an env entry on the hook command.

### 4. Merge into settings.json

Read `~/.claude/settings.json`. If it doesn't exist, create it with just the `hooks` object.

Merge in this block under `hooks.PostToolUse`:

```jsonc
{
  "matcher": "TodoWrite",
  "hooks": [
    {
      "type": "command",
      "command": "<absolute-path-to-hook>",
      "env": { "TUDU_CLAUDE_LIST": "<list-name>" }   // omit this field if list is "todo"
    }
  ]
}
```

**Merge semantics — don't clobber:**

- If `hooks.PostToolUse` already exists, append the new entry (don't replace the array).
- If there's already a `TodoWrite` matcher entry, ask the user: replace it, add this hook alongside the existing command, or skip.
- Preserve the rest of `settings.json` exactly — comments, ordering, other hooks, other top-level keys.

Show the user the proposed change as a diff before writing. Wait for confirmation.

### 5. Smoke test

After writing, verify by piping a sample payload through the hook script:

```sh
echo '{"tool_name":"TodoWrite","tool_input":{"todos":[{"content":"Tudu setup verification","status":"pending"}]}}' \
  | <absolute-path-to-hook>
```

Then `tail -5 <vault_folder>/<list-name>.md` and confirm the test line appears. If it does: delete the test line from the file (it's noise). If it doesn't: check the exit code and stderr, surface any error to the user, and stop.

### 6. Done

Tell the user:
- Next time Claude uses its todo tracker in *any* session, the list will auto-sync.
- Customize via env vars on the hook entry:
  - `TUDU_CLAUDE_LIST=<name>` — change the target list
  - `TUDU_CLAUDE_SYNC_STATUS=0` — append-only, never flip completion marks
- Summon Tudu with the hotkey (default `Ctrl+Alt+Cmd+Space`) to see live state.

## Notes for yourself (the agent)

- Use `python3 -c` or `jq` for JSON edits — never hand-edit with string concatenation. Validate the result parses before writing.
- The existing hook is idempotent (adds new, updates status, never deletes). You don't need to migrate anything when re-running this skill.
- If the user already has the hook wired, offer to *update* the list name / env rather than creating a duplicate entry.
- Don't invent anything about Tudu beyond what's in the repo's README. If asked about features you're unsure of, say so.
