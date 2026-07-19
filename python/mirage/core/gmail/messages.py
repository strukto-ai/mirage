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

import base64
from typing import Any

from mirage.core.google._client import TokenManager, gmail_base, google_get


async def list_messages(
    token_manager: TokenManager,
    label_id: str | None = None,
    query: str | None = None,
    max_results: int = 50,
) -> list[dict[str, Any]]:
    """List message IDs for a label or query.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        label_id (str | None): Gmail label ID to filter by.
        query (str | None): Gmail search query.
        max_results (int): maximum number of results.

    Returns:
        list[dict]: list of message stubs with "id" and "threadId".
    """
    params: dict[str, Any] = {"maxResults": max_results}
    if label_id:
        params["labelIds"] = label_id
    if query:
        params["q"] = query
    url = f"{gmail_base(token_manager)}/users/me/messages"
    data = await google_get(token_manager, url, params=params)
    return data.get("messages", [])


async def get_message_raw(
    token_manager: TokenManager,
    message_id: str,
) -> dict[str, Any]:
    """Get raw message JSON from API.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        message_id (str): Gmail message ID.

    Returns:
        dict: full message resource.
    """
    url = (f"{gmail_base(token_manager)}/users/me/messages"
           f"/{message_id}?format=full")
    return await google_get(token_manager, url)


def _decode_body(payload: dict[str, Any]) -> str:
    if payload.get("mimeType") == "text/plain":
        data = payload.get("body", {}).get("data", "")
        if data:
            return base64.urlsafe_b64decode(data + "==").decode(
                "utf-8", errors="replace")
    for part in payload.get("parts", []):
        text = _decode_body(part)
        if text:
            return text
    return ""


def _extract_header(headers: list[dict[str, Any]], name: str) -> str:
    for h in headers:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _parse_address(raw: str) -> dict[str, str]:
    if "<" in raw and ">" in raw:
        name = raw[:raw.index("<")].strip().strip('"')
        email = raw[raw.index("<") + 1:raw.index(">")].strip()
        return {"name": name, "email": email}
    return {"name": "", "email": raw.strip()}


def _parse_address_list(raw: str) -> list[dict[str, str]]:
    if not raw:
        return []
    return [_parse_address(a.strip()) for a in raw.split(",")]


async def get_attachment(
    token_manager: TokenManager,
    message_id: str,
    attachment_id: str,
) -> bytes:
    """Fetch and decode an attachment.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        message_id (str): Gmail message ID.
        attachment_id (str): Gmail attachment ID.

    Returns:
        bytes: decoded attachment content.
    """
    url = (f"{gmail_base(token_manager)}/users/me/messages"
           f"/{message_id}/attachments/{attachment_id}")
    data = await google_get(token_manager, url)
    raw = data.get("data", "")
    return base64.urlsafe_b64decode(raw + "==")


def _extract_attachments(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract attachment metadata from message payload.

    Args:
        payload (dict): message payload from Gmail API.

    Returns:
        list[dict]: attachment info dicts.
    """
    attachments = []
    parts = payload.get("parts", [])
    for part in parts:
        filename = part.get("filename", "")
        body = part.get("body", {})
        attachment_id = body.get("attachmentId", "")
        if filename and attachment_id:
            attachments.append({
                "filename": filename,
                "attachment_id": attachment_id,
                "size": body.get("size", 0),
                "mime_type": part.get("mimeType", ""),
            })
        if part.get("parts"):
            for sub in part["parts"]:
                fn = sub.get("filename", "")
                bd = sub.get("body", {})
                aid = bd.get("attachmentId", "")
                if fn and aid:
                    attachments.append({
                        "filename": fn,
                        "attachment_id": aid,
                        "size": bd.get("size", 0),
                        "mime_type": sub.get("mimeType", ""),
                    })
    return attachments


async def get_message_processed(
    token_manager: TokenManager,
    message_id: str,
) -> dict[str, Any]:
    """Get message as processed dict with decoded body.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        message_id (str): Gmail message ID.

    Returns:
        dict: processed message with decoded body text.
    """
    raw = await get_message_raw(token_manager, message_id)
    headers = raw.get("payload", {}).get("headers", [])
    body_text = _decode_body(raw.get("payload", {}))
    raw_atts = _extract_attachments(raw.get("payload", {}))
    attachments = [{
        "id": a["attachment_id"],
        "filename": a["filename"],
        "path": f"attachments/{a['attachment_id']}_{a['filename']}",
        "mime_type": a.get("mime_type", ""),
        "size": a["size"],
    } for a in raw_atts]
    return {
        "id": raw.get("id", ""),
        "thread_id": raw.get("threadId", ""),
        "from": _parse_address(_extract_header(headers, "From")),
        "to": _parse_address_list(_extract_header(headers, "To")),
        "cc": _parse_address_list(_extract_header(headers, "Cc")),
        "subject": _extract_header(headers, "Subject"),
        "date": _extract_header(headers, "Date"),
        "body_text": body_text,
        "snippet": raw.get("snippet", ""),
        "labels": raw.get("labelIds", []),
        "attachments": attachments,
    }
