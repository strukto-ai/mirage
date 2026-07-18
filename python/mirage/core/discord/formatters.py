from typing import Any

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


def format_grep_results(
    messages: list[dict[str, Any]],
    prefix: str,
    guild_dirname: str,
    channel_names: dict[str, str] | None = None,
) -> list[str]:
    """Format guild-search hits as grep-style lines.

    Args:
        messages (list[dict]): Discord message dicts from search_guild.
        prefix (str): mount prefix, e.g. ``"/discord"``.
        guild_dirname (str): vfs-safe guild dir name.
        channel_names (dict[str, str] | None): channel_id → vfs name.

    Returns:
        list[str]: grep-style lines, one per matched message.
    """
    names = channel_names or {}
    lines: list[str] = []
    for msg in messages:
        ts = msg.get("timestamp", "")[:10]
        ch_id = msg.get("channel_id", "")
        ch_name = names.get(ch_id, ch_id)
        author = msg.get("author", {}).get("username", "?")
        content = msg.get("content", "").replace("\n", " ")
        lines.append(f"{prefix}/{guild_dirname}/channels/{ch_name}/"
                     f"{ts}/chat.jsonl:[{author}] {content}")
    return lines
