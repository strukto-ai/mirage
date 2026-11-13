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

from datetime import timezone
from email.utils import parsedate_to_datetime
from typing import Any

from mirage.core.render.json import compact_json_text

_TRANSPORT_KEYS = frozenset({"internal_date", "raw_size"})
_IANA_FLAGS = (
    "seen",
    "answered",
    "flagged",
    "draft",
    "deleted",
    "forwarded",
    "junk",
    "not-junk",
    "phishing",
    "important",
    "mdn-sent",
)
_IANA_BY_BARE_NAME = {name.replace("-", ""): name for name in _IANA_FLAGS}


def _message_document(message: dict[str, Any]) -> dict[str, Any]:
    """Project a fetched message onto the document mirage serves.

    INTERNALDATE is dropped: it is the mailbox's own arrival stamp, which
    picks the date directory when the ``Date:`` header is missing, not a
    field of the message. The gmail backend keeps its internalDate out of
    the rendered JSON the same way.

    Args:
        message (dict): a fetched message from ``fetch_message`` or
            ``fetch_headers``.

    Returns:
        dict: the message without its transport-only keys.
    """
    return {k: v for k, v in message.items() if k not in _TRANSPORT_KEYS}


def message_json_text(message: dict[str, Any]) -> str:
    """Render one parsed message as its .email.json text.

    Args:
        message (dict): parsed message dict from ``parse_rfc822``.
    """
    return compact_json_text(_message_document(message))


def message_json_bytes(message: dict[str, Any]) -> bytes:
    """Render one parsed message as its .email.json body.

    Args:
        message (dict): parsed message dict from ``parse_rfc822``.
    """
    # Single renderer for .email.json: the listing fetches the full message
    # with BODY.PEEK[] and parses it exactly like read() does, so sizing a
    # listed header dict here yields the byte length read() will return.
    # Every other serializer of a fetched message routes through here too,
    # so `himalaya message read` cannot drift from `cat`.
    return message_json_text(message).encode()


def _normalized_id(raw: str) -> str | None:
    trimmed = raw.strip()
    if trimmed.startswith("<") and trimmed.endswith(">"):
        trimmed = trimmed[1:-1].strip()
    return trimmed or None


def _message_ids(raw: str) -> list[str]:
    if "<" in raw:
        chunks = [c.split(">", 1)[0] for c in raw.split("<") if ">" in c]
    else:
        chunks = raw.split()
    return [found for c in chunks if (found := _normalized_id(c)) is not None]


def _flag_documents(flags: list[str]) -> list[dict[str, str | None]]:
    """A message's flags as upstream renders them.

    Classified against the IANA registry, one entry per flag, IANA flags
    first in the registry's order and keywords after them by name.
    ``\\Recent`` is the server's own bookkeeping and is left out.

    Args:
        flags (list[str]): the flags as the server spelled them.
    """
    found: dict[str, dict[str, str | None]] = {}
    for raw in flags:
        if raw.lower() == "\\recent":
            continue
        bare = raw[1:] if raw[:1] in ("\\", "$") else raw
        iana = _IANA_BY_BARE_NAME.get(bare.lower())
        found.setdefault(iana or raw.lower(), {"raw": raw, "iana": iana})
    return sorted(found.values(), key=_flag_rank)


def _flag_rank(flag: dict[str, str | None]) -> tuple[int, str]:
    iana = flag["iana"]
    if iana is not None:
        return _IANA_FLAGS.index(iana), ""
    return len(_IANA_FLAGS), str(flag["raw"]).lower()


def _addresses(entries: list[dict[str, str]]) -> list[dict[str, str | None]]:
    return [
        {"name": entry.get("name") or None, "email": entry["email"]}
        for entry in entries
        if entry.get("email")
    ]


def _rfc3339(date: str) -> str | None:
    """A ``Date:`` header as RFC 3339, None when it cannot be read.

    Args:
        date (str): the header's text.
    """
    try:
        parsed = parsedate_to_datetime(date)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    text = parsed.isoformat()
    return f"{text[:-6]}Z" if text.endswith("+00:00") else text


def _envelope_document(
    message: dict[str, Any], with_attachment: bool
) -> dict[str, Any]:
    """Project a fetched message onto upstream himalaya's envelope.

    Args:
        message (dict): a fetched message from ``fetch_headers``.
        with_attachment (bool): whether --has-attachment asked for it,
            None being upstream's answer otherwise.
    """
    return {
        "id": message["uid"],
        "message-id": _normalized_id(message.get("message_id") or ""),
        "in-reply-to": _message_ids(message.get("in_reply_to") or ""),
        "flags": _flag_documents(message.get("flags", [])),
        "subject": message.get("subject", ""),
        "from": _addresses([message.get("from") or {}]),
        "to": _addresses(message.get("to", [])),
        "date": _rfc3339(message.get("date", "")),
        "size": message.get("raw_size", 0),
        "has-attachment": (
            message["has_attachments"] if with_attachment else None
        ),
    }


def envelope_documents(
    messages: list[dict[str, Any]], with_attachment: bool = False
) -> list[dict[str, Any]]:
    """The envelope records a listing shows, one per message.

    Args:
        messages (list[dict[str, Any]]): parsed messages.
        with_attachment (bool): fill ``has-attachment``.
    """
    return [_envelope_document(one, with_attachment) for one in messages]
