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

from datetime import datetime, timezone

from mirage.core.gmail.messages import (_decode_body, _extract_header,
                                        get_message_processed, get_message_raw,
                                        list_messages)
from mirage.core.gmail.readdir import _sanitize
from mirage.core.gmail.scope import GmailScope
from mirage.core.google._client import TokenManager

EXCERPT_WINDOW = 120
EXCERPT_MAX = 240


def _extract_excerpt(text: str, pattern: str) -> str:
    if not text or not pattern:
        return ""
    flat = " ".join(text.split())
    idx = flat.lower().find(pattern.lower())
    if idx < 0:
        return flat[:EXCERPT_MAX]
    start = max(0, idx - EXCERPT_WINDOW)
    end = min(len(flat), idx + len(pattern) + EXCERPT_WINDOW)
    prefix = "..." if start > 0 else ""
    suffix = "..." if end < len(flat) else ""
    return f"{prefix}{flat[start:end]}{suffix}"


def _build_query(pattern: str, label_name: str | None,
                 date_str: str | None) -> str:
    parts = [pattern]
    if label_name:
        parts.append(f"label:{label_name}")
    if date_str:
        try:
            dt = datetime.strptime(date_str, "%Y-%m-%d")
            parts.append(f"after:{dt.strftime('%Y/%m/%d')}")
        except ValueError:
            # invalid date filter: skip the clause rather than fail the search
            pass
    return " ".join(parts)


def _date_from_internal(internal_date: str) -> str:
    try:
        ts = int(internal_date) / 1000
    except (TypeError, ValueError):
        return ""
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


async def search_messages(
    token_manager: TokenManager,
    pattern: str,
    label_name: str | None = None,
    date_str: str | None = None,
    max_results: int = 50,
) -> list[dict]:
    """Search Gmail and return formatted result rows.

    Returns:
        list[dict]: each row has keys path, subject, snippet, sender.
    """
    query = _build_query(pattern, label_name, date_str)
    stubs = await list_messages(
        token_manager,
        query=query,
        max_results=max_results,
    )
    rows: list[dict] = []
    for stub in stubs:
        mid = stub.get("id")
        if not mid:
            continue
        raw = await get_message_raw(token_manager, mid)
        headers = raw.get("payload", {}).get("headers", [])
        subject = _extract_header(headers, "Subject") or "No Subject"
        sender = _extract_header(headers, "From") or "?"
        snippet = raw.get("snippet", "")
        body_text = _decode_body(raw.get("payload", {}))
        msg_date = _date_from_internal(raw.get("internalDate", "0"))
        rows.append({
            "id": mid,
            "subject": subject,
            "snippet": snippet,
            "sender": sender,
            "date": msg_date,
            "label": label_name or "",
            "body_text": body_text,
        })
    return rows


def format_grep_results(
    rows: list[dict],
    scope: GmailScope,
    prefix: str,
    pattern: str = "",
) -> list[str]:
    lines: list[str] = []
    for row in rows:
        label = row.get("label") or scope.label_name or "INBOX"
        date = row.get("date", "")
        mid = row.get("id", "")
        subject_clean = _sanitize(row.get("subject") or "No Subject")
        filename = f"{subject_clean}__{mid}.gmail.json"
        sender = row.get("sender", "?")
        haystack = f"{row.get('subject', '')}\n{row.get('body_text', '')}"
        excerpt = _extract_excerpt(haystack, pattern) if pattern else ""
        if not excerpt:
            excerpt = (row.get("snippet") or "").replace("\n", " ")
        path = (f"{prefix}/{label}/{date}/{filename}"
                if date else f"{prefix}/{label}/{filename}")
        lines.append(f"{path}:[{sender}] {excerpt}")
    return lines


__all__ = [
    "search_messages",
    "get_message_processed",
    "format_grep_results",
]
