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

import httpx
from starlette.types import Scope, Send

from mirage.server.rate_limit import COUNTED_HEADER
from mirage.server.workers.constants import HOP_BY_HOP
from mirage.server.workers.types import Answer


def path_parts(path: str) -> list[str]:
    """The segments of a request's path, which ASGI has decoded."""
    return path.split("/")[1:]


def answered(response: httpx.Response) -> Answer:
    """A worker's whole answer."""
    return Answer(
        response.status_code,
        [(k.decode(), v.decode()) for k, v in response.headers.raw],
        response.content,
    )


def headers_for(scope: Scope) -> list[tuple[str, str]]:
    headers = [
        (k.decode("latin-1").lower(), v.decode("latin-1"))
        for k, v in scope["headers"]
    ]
    client = scope.get("client")
    kept = [
        (k, v)
        for k, v in headers
        if k not in HOP_BY_HOP
        # Only the daemon says a request was counted.
        and k not in ("x-forwarded-for", "content-length", COUNTED_HEADER)
    ]
    kept.append(("x-forwarded-for", client[0] if client else ""))
    return kept


def target(scope: Scope) -> str:
    """A request's path and query, as the client sent them."""
    path: bytes = scope.get("raw_path") or scope["path"].encode()
    query: bytes = scope.get("query_string", b"")
    return path.decode("latin-1") + ("?" + query.decode() if query else "")


def framed(scope: Scope, host: str) -> list[tuple[str, str]]:
    """A request's headers for its worker, with its body framed as the
    client framed it."""
    headers = headers_for(scope)
    sent = {
        k.decode("latin-1").lower(): v.decode("latin-1")
        for k, v in scope["headers"]
    }
    if "content-length" in sent:
        headers.append(("content-length", sent["content-length"]))
    elif "transfer-encoding" in sent:
        headers.append(("transfer-encoding", "chunked"))
    if not any(k == "host" for k, _ in headers):
        headers.append(("host", host))
    return headers


def passable(raw: list[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
    return [
        (k, v) for k, v in raw if k.decode("latin-1").lower() not in HOP_BY_HOP
    ]


async def send_json(send: Send, status: int, body: Any) -> None:
    payload = json.dumps(body, separators=(",", ":")).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})


async def send_answer(send: Send, answer: Answer) -> None:
    headers = [
        (k.encode("latin-1"), v.encode("latin-1"))
        for k, v in answer.headers
        if k.lower() not in HOP_BY_HOP and k.lower() != "content-length"
    ]
    headers.append((b"content-length", str(len(answer.body)).encode()))
    await send(
        {
            "type": "http.response.start",
            "status": answer.status,
            "headers": headers,
        }
    )
    await send({"type": "http.response.body", "body": answer.body})
