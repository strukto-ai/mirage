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
from typing import Any

from mirage.core.email._client import INTERNAL_DATE_KEY


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
    return json.dumps(_message_document(message),
                      ensure_ascii=False,
                      separators=(",", ":"))


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


def messages_json_bytes(messages: list[dict[str, Any]]) -> bytes:
    """Render a list of fetched messages as one JSON array.

    Args:
        messages (list[dict]): fetched messages, in output order.
    """
    return json.dumps([_message_document(m) for m in messages],
                      ensure_ascii=False,
                      separators=(",", ":")).encode()
