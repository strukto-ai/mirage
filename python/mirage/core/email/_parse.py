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

from email import policy
from email.parser import BytesParser
from typing import Any


def parse_rfc822(raw: bytes, headers_only: bool = False) -> dict[str, Any]:
    parser = BytesParser(policy=policy.default)
    if headers_only:
        msg = parser.parsebytes(raw, headersonly=True)
    else:
        msg = parser.parsebytes(raw)

    body_text, body_html = "", ""
    attachments: list[dict[str, Any]] = []

    if not headers_only:
        body_text, body_html, attachments = _extract_parts(msg)

    return {
        "from": _parse_address(msg.get("From", "")),
        "to": _parse_address_list(msg.get("To", "")),
        "cc": _parse_address_list(msg.get("Cc", "")),
        "subject": msg.get("Subject", ""),
        "date": msg.get("Date", ""),
        "body_text": body_text,
        "body_html": body_html,
        "snippet": body_text[:100],
        "message_id": msg.get("Message-ID", ""),
        "in_reply_to": msg.get("In-Reply-To") or None,
        "references": (msg.get("References") or "").split(),
        "has_attachments": bool(attachments),
        "attachments": attachments,
    }


def _extract_parts(msg) -> tuple[str, str, list[dict[str, Any]]]:
    text, html = "", ""
    attachments: list[dict[str, Any]] = []

    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            disposition = str(part.get("Content-Disposition", ""))

            if "attachment" in disposition:
                payload = part.get_payload(decode=True) or b""
                attachments.append({
                    "filename": part.get_filename() or "unnamed",
                    "content_type": content_type,
                    "size": len(payload),
                })
            elif content_type == "text/plain" and not text:
                text = (part.get_payload(decode=True)
                        or b"").decode(part.get_content_charset() or "utf-8",
                                       errors="replace")
            elif content_type == "text/html" and not html:
                html = (part.get_payload(decode=True)
                        or b"").decode(part.get_content_charset() or "utf-8",
                                       errors="replace")
    else:
        content_type = msg.get_content_type()
        payload = msg.get_payload(decode=True) or b""
        decoded = payload.decode(msg.get_content_charset() or "utf-8",
                                 errors="replace")
        if content_type == "text/html":
            html = decoded
        else:
            text = decoded

    return text, html, attachments


def _parse_address(raw: str) -> dict[str, str]:
    if not raw:
        return {"name": "", "email": ""}
    if "<" in raw and ">" in raw:
        name = raw[:raw.index("<")].strip().strip('"')
        email = raw[raw.index("<") + 1:raw.index(">")]
        return {"name": name, "email": email}
    return {"name": "", "email": raw.strip()}


def _parse_address_list(raw: str) -> list[dict[str, str]]:
    if not raw:
        return []
    return [_parse_address(a.strip()) for a in raw.split(",")]
