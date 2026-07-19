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


def _extract_text(node: dict[str, Any]) -> str:
    if node.get("type") == "text" and isinstance(node.get("text"), str):
        return node["text"]
    content = node.get("content")
    if isinstance(content, list):
        return "".join(_extract_text(c) for c in content)
    return ""


def _extract_authors(node: dict[str, Any], out: dict[str, None]) -> None:
    # dict-as-ordered-set: TS uses a Set, which iterates in insertion
    # order; a python set would emit authors in arbitrary order.
    marks = node.get("marks")
    if isinstance(marks, list):
        for m in marks:
            if m.get("type") == "author_id" and isinstance(
                    m.get("attrs"), dict):
                author_id = m["attrs"].get("authorId")
                if isinstance(author_id, str):
                    out[author_id] = None
    content = node.get("content")
    if isinstance(content, list):
        for c in content:
            _extract_authors(c, out)


def _extract_paragraphs(content: Any) -> list[dict[str, Any]]:
    if not isinstance(content, list):
        return []
    out: list[dict[str, Any]] = []
    for node in content:
        if node.get("type") == "paragraph":
            authors: dict[str, None] = {}
            _extract_authors(node, authors)
            out.append({"text": _extract_text(node), "authors": list(authors)})
    return out


def _ms_to_iso(ts: Any) -> str:
    if not isinstance(ts, (int, float)):
        return ""
    dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def process_boxnote(raw_bytes: bytes) -> bytes:
    """Restructure Box's raw .boxnote JSON into an agent-friendly shape.

    Emits a top-level body_text field for one-shot reads, mirroring the
    gdocs read pattern.

    Args:
        raw_bytes (bytes): raw .boxnote file content.
    """
    raw = json.loads(raw_bytes.decode("utf-8"))
    doc = raw.get("doc") or {}
    paragraphs = _extract_paragraphs(doc.get("content"))
    body_text = "\n".join(p["text"] for p in paragraphs)
    savepoint = raw.get("savepoint_metadata") or {}
    processed = {
        "id": savepoint.get("savepointFileId") or "",
        "body_text": body_text,
        "paragraphs": paragraphs,
        "authors": savepoint.get("allAuthorNames") or {},
        "last_edit_at": _ms_to_iso(raw.get("last_edit_timestamp")),
    }
    return (json.dumps(processed, indent=2, ensure_ascii=False) +
            "\n").encode("utf-8")
