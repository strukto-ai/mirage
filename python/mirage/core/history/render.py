# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from typing import Any

from mirage.observe.log_entry import EVENT_COMMAND

HISTSIZE = 500


def render_bash_history(events: list[dict[str, Any]]) -> str:
    """Render command events as a GNU bash histfile.

    One `#<epoch-seconds>` timestamp comment line per entry followed by
    the command line (bash HISTTIMEFORMAT file layout). Non-command
    events (ops, clear tombstones) are ignored, exactly as bash's
    histfile ignores `history -c`.

    Args:
        events (list[dict]): LogEntry dicts, ordered by timestamp.

    Returns:
        str: Rendered histfile text, empty when no commands exist.
    """
    lines: list[str] = []
    for e in events:
        if e.get("type") != EVENT_COMMAND:
            continue
        lines.append(f"#{int(e.get('timestamp', 0) / 1000)}")
        lines.append(e.get("command", ""))
    return "\n".join(lines) + ("\n" if lines else "")


def render_history_listing(
    events: list[dict[str, Any]],
    n: int | None = None,
    histsize: int = HISTSIZE,
) -> str:
    """Render command events as `history` command output.

    Args:
        events (list[dict]): One session's command events, append order.
        n (int | None): Show only the last n entries when given.
        histsize (int): Cap on the visible list (GNU HISTSIZE).

    Returns:
        str: Numbered listing, right-justified, two-space separated.
    """
    scoped = [e for e in events if e.get("type") == EVENT_COMMAND][-histsize:]
    if n is None or n < 0:
        entries = scoped
    else:
        # bash lists nothing for n=0; scoped[-0:] would list everything.
        entries = scoped[-n:] if n > 0 else []
    total = len(scoped)
    width = len(str(total))
    start_idx = total - len(entries) + 1
    lines = [
        f"{str(start_idx + i).rjust(width)}  {e.get('command', '')}"
        for i, e in enumerate(entries)
    ]
    return "\n".join(lines) + ("\n" if lines else "")
