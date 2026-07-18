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
from typing import Any


def _extract_text(node: Any) -> str:
    if not isinstance(node, dict):
        return ""
    if node.get("type") == "text" and isinstance(node.get("text"), str):
        return node["text"]
    content = node.get("content")
    if isinstance(content, list):
        parts = []
        for c in content:
            t = _extract_text(c)
            # Add newline after each paragraph for readability.
            parts.append(t + "\n" if c.get("type") == "paragraph" else t)
        return "".join(parts)
    return ""


def _ts_to_iso(ts: Any) -> str:
    if not isinstance(ts, (int, float)):
        return ""
    # Box canvas timestamps are seconds, not ms.
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def process_boxcanvas(raw_bytes: bytes) -> bytes:
    """Restructure Box's raw .boxcanvas JSON into an agent-friendly shape.

    Emits widget counts by type, concatenated body_text from all widgets
    that carry doc content, and per-widget metadata. Mirrors the boxnote
    and gdocs pattern.

    Args:
        raw_bytes (bytes): raw .boxcanvas file content.
    """
    raw = json.loads(raw_bytes.decode("utf-8"))
    widgets = raw.get("widgets")
    if not isinstance(widgets, list):
        widgets = []
    by_type: dict[str, int] = {}
    # dict-as-ordered-set: TS uses a Set, which iterates in insertion
    # order; a python set would emit authors in arbitrary order.
    authors: dict[str, None] = {}
    body_parts: list[str] = []
    processed: list[dict[str, Any]] = []
    for w in widgets:
        data = w.get("data") or {}
        widget_type = data.get("type") or "unknown"
        by_type[widget_type] = by_type.get(widget_type, 0) + 1
        user_id = w.get("userId")
        if isinstance(user_id, str) and user_id:
            authors[user_id] = None
        modified_by = w.get("lastModifiedBy")
        if isinstance(modified_by, str) and modified_by:
            authors[modified_by] = None
        widget_text = _extract_text(data.get("content")).rstrip("\n")
        if widget_text:
            body_parts.append(widget_text)
        processed.append({
            "id": w.get("id") or "",
            "type": widget_type,
            "user_id": user_id or "",
            "created_at": _ts_to_iso(w.get("createdTs")),
            "modified_at": _ts_to_iso(w.get("lastModifiedTs")),
            "modified_by": modified_by or "",
            "text": widget_text,
        })
    out = {
        "id": (raw.get("board") or {}).get("id") or "",
        "widget_count": len(widgets),
        "widgets_by_type": by_type,
        "body_text": "\n".join(body_parts),
        "widgets": processed,
        "authors": list(authors),
    }
    return (json.dumps(out, indent=2, ensure_ascii=False) +
            "\n").encode("utf-8")
