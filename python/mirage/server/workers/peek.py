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
import logging
from collections.abc import AsyncIterator

from fastapi import HTTPException
from starlette.types import Receive, Scope

from mirage.server.multipart import MAX_REQUEST_PART, PartEvent, part_events
from mirage.server.workers.types import Peeked

logger = logging.getLogger(__name__)


def id_of(body: bytes) -> str | None:
    """The workspace id a create names: its ``id``, else its config's
    ``workspace_id``."""
    try:
        parsed = json.loads(body)
    except ValueError as exc:
        # The worker refuses a body that is not JSON; it names no id here.
        logger.debug(
            "mirage: a create body is not JSON: %s", type(exc).__name__
        )
        return None
    if not isinstance(parsed, dict):
        return None
    config = parsed.get("config")
    made = parsed.get("id")
    if made is None and isinstance(config, dict):
        made = config.get("workspace_id")
    return made if isinstance(made, str) else None


async def chunks(receive: Receive) -> AsyncIterator[bytes]:
    while True:
        message = await receive()
        if message["type"] != "http.request":
            return
        if message.get("body"):
            yield message["body"]
        if not message.get("more_body"):
            return


async def peek(scope: Scope, receive: Receive) -> Peeked:
    """Read a create's body, up to ``MAX_REQUEST_PART``, until the
    workspace id it names is known: a JSON body whole, or a multipart
    load's parts up to the end of its ``request`` part. Past the limit the
    id is not known.

    Returns:
        Peeked: what was read, whether more follows, and the id.
    """
    content_type = ""
    for k, v in scope["headers"]:
        if k.lower() == b"content-type":
            content_type = v.decode("latin-1")
    chunks: list[bytes] = []
    size = 0
    more = True

    async def read() -> AsyncIterator[bytes]:
        nonlocal more, size
        while more:
            message = await receive()
            chunk = message.get("body", b"")
            more = (
                bool(message.get("more_body"))
                and message["type"] == "http.request"
            )
            chunks.append(chunk)
            size += len(chunk)
            yield chunk
            # Checked once the chunk is parsed: it may end the request part
            # and run past the limit, and bytes before the first part make
            # no event.
            if size > MAX_REQUEST_PART:
                return

    if not content_type.startswith("multipart/"):
        async for _ in read():
            if size > MAX_REQUEST_PART:
                return Peeked(b"".join(chunks), more, None, lost=True)
        head = b"".join(chunks)
        return Peeked(head, False, id_of(head))
    request: list[bytes] = []
    name = b""
    named = False
    twice = False
    events = part_events(read(), content_type)
    try:
        async for kind, value in events:
            # Read on to the next part, which must not be a second request.
            if kind == PartEvent.BEGIN:
                if name == b"request":
                    twice = value == b"request"
                    break
                name = value
            elif kind == PartEvent.DATA and name == b"request":
                request.append(bytes(value))
            elif kind == PartEvent.END and name == b"request":
                named = True
    except HTTPException as exc:
        # A malformed body goes on as it is, for the worker to refuse.
        logger.debug("mirage: a load body did not parse: %s", exc.detail)
    finally:
        await events.aclose()
    return Peeked(
        b"".join(chunks),
        more,
        id_of(b"".join(request)),
        lost=not named and size > MAX_REQUEST_PART,
        twice=twice,
    )
