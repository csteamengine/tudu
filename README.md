# Tudu

A floating, Spotlight-style todo panel for macOS, backed by plain Markdown files in an Obsidian vault. Summon with a global hotkey from any Space — including over full-screen apps — and auto-sync with Claude Code's `TodoWrite` so anything Claude is working on shows up in your personal list.

## Features

- **Global hotkey** summons a translucent panel anywhere, including over full-screen apps and on any Space
- **Per-monitor position memory** — drag to a spot on each monitor; that's where it appears next time you're there
- **Sticky mode** — keep it visible; it follows your cursor across monitors with a short debounce and a quick fade
- **Tabs per list** — each list is a `.md` file in your chosen vault folder
- **Nested tasks** with drag-and-drop reorder/nest (TickTick-style: drop above, below, or into another task)
- **Obsidian-compatible** — writes `- [ ] task ^blockid` so block refs stay stable
- **Claude Code integration** — optional `TodoWrite` hook mirrors Claude's session todos into a list of your choice

## Install

### Build from source (currently the only path)

Requires Rust (`cargo`), Node 22+, and `pnpm`.

```sh
git clone https://github.com/<you>/tudu
cd tudu
pnpm install
pnpm tauri build   # produces a .dmg under src-tauri/target/release/bundle/dmg/
```

Or run in dev mode:

```sh
pnpm tauri dev
```

On first launch, open Settings (gear icon) and pick a **vault folder**. That folder is where your list files (`.md`) live — pick a folder inside your Obsidian vault if you use Obsidian.

Default hotkey is `Ctrl+Alt+Cmd+Space`. Click **Record** in Settings to change it.

## How it's organized

- Each list is a separate `.md` file in the vault folder. The tab name = the filename.
- Tasks are plain Markdown: `- [ ] content ^blockid` with 2-space indents for subtasks.
- You can edit these files directly in Obsidian (or any editor). Tudu picks up changes via a file watcher.

## Claude Code integration

A `PostToolUse` hook listens for Claude's `TodoWrite` tool calls and mirrors them into a list file of your choice (default: `todo.md` in your vault folder).

**What this gives you**: every session where Claude uses its todo tracker — which it does for most multi-step work — the items show up in your Tudu list in real time, complete with status mirroring. If Claude marks a todo `completed`, the `[ ]` flips to `[x]` in your list.

### Setup (option 1: skill)

Copy `skills/tudu-setup` into your `~/.claude/skills/` directory, then in any Claude Code session run:

```
/tudu-setup
```

The skill walks you through wiring the hook and choosing a list name.

### Setup (option 2: manual)

Add to `~/.claude/settings.json`:

```jsonc
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "TodoWrite",
        "hooks": [
          { "type": "command", "command": "/absolute/path/to/tudu/hooks/claude-tudu-hook.py" }
        ]
      }
    ]
  }
}
```

Make sure the script is executable: `chmod +x hooks/claude-tudu-hook.py`.

### Hook env vars

- `TUDU_CLAUDE_LIST` — which list file to write to. Default `todo`. Set to `Claude` to use `Claude.md` instead.
- `TUDU_CLAUDE_SYNC_STATUS=0` — don't mirror completion state (only appends new todos, never flips marks).

### What the hook does and doesn't do

- **Does**: append new todos from Claude, update completion marks when content matches, preserve block IDs across updates, safely handle multiple concurrent Claude sessions (fcntl lock).
- **Does not**: delete a Tudu task when Claude drops it from its list (cautious by design — never touches user-added tasks). Match on rephrased content (dedup is by text). Fire if Claude chooses not to call `TodoWrite` for a given exchange.

## Configuration file

Settings live at `~/Library/Application Support/tudu/config.json`:

```jsonc
{
  "vault_folder": "/path/to/your/vault",
  "last_list": "todo",
  "hotkey": "Ctrl+Alt+Cmd+Space",
  "sticky": false,
  "window_width": 468,
  "window_height": 268,
  "monitor_positions": {
    "display-2": { "x": 390, "y": 957, "width": 468, "height": 268 },
    "display-5": { "x": 1434, "y": 462, "width": 936, "height": 536 }
  }
}
```

Per-monitor entries are keyed by `CGDirectDisplayID` (stable per physical display across reboots).

## Architecture notes

- **Tauri v2** (Rust + TypeScript), vanilla TS frontend (no framework).
- **NSPanel** on macOS: the window class is swapped to a subclass of `NSPanel` at runtime with `canBecomeKeyWindow` overridden, plus `NSWindowCollectionBehaviorCanJoinAllSpaces | FullScreenAuxiliary | Stationary` and `NSStatusWindowLevel`. This is how the panel overlays full-screen apps without triggering a Space switch.
- **Accessory app policy** (`NSApplicationActivationPolicyAccessory`) — no Dock icon, no Cmd-Tab entry, reliable keyboard focus on the panel.
- **Native vibrancy** via the `window-vibrancy` crate (AppKit `NSVisualEffectView`) — survives during drag and renders correctly in screen recordings, unlike CSS `backdrop-filter`.
- **Multi-monitor cursor detection** uses `NSEvent.mouseLocation` + `NSScreen.screens` directly, because Tauri/tao's `cursor_position()` uses the main screen's height for the Y-flip, which gives wrong values on secondary displays.

## Development

```sh
pnpm tauri dev        # run with hot reload
cargo check           # Rust type-check (from src-tauri/)
pnpm tsc --noEmit     # TS type-check
```

## License

MIT
