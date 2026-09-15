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

from mirage.core.email.client import INTERNAL_DATE_KEY
from mirage.core.render.json import compact_json_bytes, compact_json_text

BODY_KEYS = frozenset({"body_text", "body_html", "snippet"})


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
    return {k: v for k, v in message.items() if k != INTERNAL_DATE_KEY}


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


def _envelope_document(message: dict[str, Any]) -> dict[str, Any]:
    """Project a fetched message onto its envelope.

    The envelope is the message without its body: identifiers, headers,
    flags and attachment metadata stay; ``body_text``, ``body_html`` and
    the body-derived ``snippet`` go, along with INTERNALDATE. Listing a
    mailbox fetches every full source because attachment names live in
    the MIME structure, but a page of envelopes must not carry a page of
    HTML bodies. Those are ``message read``'s and the mounted
    .email.json's, which render through ``_message_document``.

    Args:
        message (dict): a fetched message from ``fetch_headers``.
    """
    return {
        k: v
        for k, v in message.items()
        if k != INTERNAL_DATE_KEY and k not in BODY_KEYS
    }


def envelopes_json_bytes(messages: list[dict[str, Any]]) -> bytes:
    """Render fetched messages as one JSON array of envelopes.

    Args:
        messages (list[dict]): fetched messages, in output order.
    """
    return compact_json_bytes([_envelope_document(m) for m in messages])
