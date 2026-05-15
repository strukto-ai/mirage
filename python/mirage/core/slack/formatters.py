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

import json
from datetime import datetime, timezone

from mirage.core.slack.files import file_blob_name
from mirage.core.slack.scope import SlackScope
from mirage.utils.sanitize import sanitize_name


def build_query(pattern: str, scope: SlackScope) -> str:
    """Compose a Slack search query string for a pushed-down grep/rg call.

    Args:
        pattern (str): user-supplied pattern.
        scope (SlackScope): the Slack-side directory the grep is rooted at.

    Returns:
        str: query with optional in:#channel or in:@user prefix.
    """
    if scope.container == "channels" and scope.channel_name:
        return f"in:#{scope.channel_name} {pattern}"
    if scope.container == "dms" and scope.channel_name:
        return f"in:@{scope.channel_name} {pattern}"
    return pattern


def format_grep_results(
    raw: bytes,
    scope: SlackScope,
    prefix: str,
) -> list[str]:
    """Format a Slack search.messages JSON response as grep-style lines.

    Args:
        raw (bytes): JSON-encoded search.messages response.
        scope (SlackScope): the rooted scope used to compute relative paths.
        prefix (str): VFS mount prefix to prepend.

    Returns:
        list[str]: grep-formatted lines, one per match.
    """
    payload = json.loads(raw.decode())
    matches = payload.get("messages", {}).get("matches", []) or []
    lines: list[str] = []
    for msg in matches:
        ch = msg.get("channel", {}) or {}
        ch_name = ch.get("name") or scope.channel_name or ""
        ch_id = ch.get("id") or scope.channel_id or ""
        container = scope.container or "channels"
        ts_raw = msg.get("ts", "0")
        try:
            ts_float = float(ts_raw)
            date_str = datetime.fromtimestamp(
                ts_float, tz=timezone.utc).date().isoformat()
        except (TypeError, ValueError):
            date_str = ""
        safe_name = sanitize_name(ch_name)
        dirname = f"{safe_name}__{ch_id}" if ch_id else safe_name
        path = (f"{prefix}/{container}/{dirname}/{date_str}/chat.jsonl"
                if date_str else f"{prefix}/{container}/{dirname}")
        author = msg.get("username") or msg.get("user") or "?"
        text = (msg.get("text") or "").replace("\n", " ")
        lines.append(f"{path}:[{author}] {text}")
    return lines


def format_file_grep_results(
    raw: bytes,
    scope: SlackScope,
    prefix: str,
) -> list[str]:
    """Format a Slack search.files JSON response as grep-style lines.

    Args:
        raw (bytes): JSON-encoded search.files response.
        scope (SlackScope): the rooted scope (must have channel_id).
        prefix (str): VFS mount prefix to prepend.

    Returns:
        list[str]: grep-formatted lines, one per file match.
    """
    payload = json.loads(raw.decode())
    matches = payload.get("files", {}).get("matches", []) or []
    lines: list[str] = []
    for f in matches:
        fid = f.get("id", "")
        title = (f.get("title") or f.get("name") or fid)
        blob_name = file_blob_name(f)
        ts = f.get("timestamp", 0)
        try:
            date_str = datetime.fromtimestamp(
                float(ts), tz=timezone.utc).date().isoformat()
        except (TypeError, ValueError):
            date_str = ""
        if not scope.channel_id:
            continue
        ch_id = scope.channel_id
        ch_name = scope.channel_name or ""
        safe_name = sanitize_name(ch_name) if ch_name else ""
        dirname = f"{safe_name}__{ch_id}" if safe_name else ch_id
        container = scope.container or "channels"
        path = (f"{prefix}/{container}/{dirname}/{date_str}/files/{blob_name}"
                if date_str else
                f"{prefix}/{container}/{dirname}/files/{blob_name}")
        lines.append(f"{path}:[file] {title}")
    return lines
