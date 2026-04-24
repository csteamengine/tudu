#!/usr/bin/env python3
"""Claude Code PostToolUse hook for TodoWrite → Tudu vault sync.

Wire up in ~/.claude/settings.json:

  {
    "hooks": {
      "PostToolUse": [
        {
          "matcher": "TodoWrite",
          "hooks": [
            {"type": "command", "command": "/absolute/path/to/claude-tudu-hook.py"}
          ]
        }
      ]
    }
  }

Environment overrides:
  TUDU_CLAUDE_LIST        - list name (default "Claude"), writes <vault>/<list>.md
  TUDU_CLAUDE_SYNC_STATUS - "0" to skip mirroring completion state (default on)
"""
import fcntl
import json
import os
import random
import re
import string
import sys
from pathlib import Path


TASK_RE = re.compile(r"^(\s*)- \[([ xX])\] (.+?)(?:\s+\^([a-z0-9]+))?\s*$")


def config_path() -> Path:
    primary = Path.home() / "Library" / "Application Support" / "tudu" / "config.json"
    alt = Path.home() / ".config" / "tudu" / "config.json"
    return primary if primary.exists() else alt


def vault_file() -> Path:
    folder: Path
    try:
        cfg = json.loads(config_path().read_text())
        folder = Path(cfg.get("vault_folder") or (Path.home() / "TuduVault"))
    except Exception:
        folder = Path.home() / "TuduVault"
    list_name = os.environ.get("TUDU_CLAUDE_LIST", "todo")
    return folder / f"{list_name}.md"


def new_id() -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=6))


def normalize(s: str) -> str:
    return s.strip().lower()


def sync(path: Path, todos: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sync_status = os.environ.get("TUDU_CLAUDE_SYNC_STATUS", "1") != "0"

    path.touch(exist_ok=True)
    with open(path, "r+", encoding="utf-8") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            lines = f.read().splitlines()

            top_level_index: dict[str, int] = {}
            for i, line in enumerate(lines):
                m = TASK_RE.match(line)
                if not m or len(m.group(1)) > 0:
                    continue
                top_level_index[normalize(m.group(3))] = i

            for t in todos:
                content = (t.get("content") or t.get("subject") or "").strip()
                if not content:
                    continue
                done = t.get("status") == "completed"
                mark = "x" if done else " "
                key = normalize(content)

                if key in top_level_index:
                    if not sync_status:
                        continue
                    i = top_level_index[key]
                    m = TASK_RE.match(lines[i])
                    if not m:
                        continue
                    current_mark = m.group(2).lower()
                    if current_mark == mark:
                        continue
                    block = m.group(4) or new_id()
                    lines[i] = f"- [{mark}] {content} ^{block}"
                else:
                    lines.append(f"- [{mark}] {content} ^{new_id()}")
                    top_level_index[key] = len(lines) - 1

            out = "\n".join(lines)
            if out and not out.endswith("\n"):
                out += "\n"
            f.seek(0)
            f.truncate()
            f.write(out)
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    todos = (payload.get("tool_input") or {}).get("todos") or []
    if not todos:
        return 0
    try:
        sync(vault_file(), todos)
    except Exception as e:
        print(f"tudu hook: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
