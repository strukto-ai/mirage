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

import asyncio
import json
import sys
from collections.abc import AsyncGenerator, Callable

import anyio
import httpx

from mirage.concurrency.limiter import run_blocking
from mirage.server.rpc.constants import RPC_PARSE_ERROR
from mirage.server.rpc.server import CANCEL_REQUEST, error_response


async def relay_stdio(url: str, token: Callable[[], str]) -> None:
    """Relay this process's line-delimited JSON-RPC to a daemon's ``/rpc``.

    Each request is posted on its own, so answers come back as they
    finish and ``$/cancelRequest`` reaches a request still running.

    Args:
        url (str): the workspace's ``/v1/workspaces/{id}/rpc`` URL.
        token (Callable[[], str]): the bearer token, asked for on every
            request, so a login refreshed while the relay runs is sent;
            empty sends none.
    """

    class Bearer(httpx.Auth):
        async def async_auth_flow(
            self, request: httpx.Request
        ) -> AsyncGenerator[httpx.Request, httpx.Response]:
            value = await run_blocking(token)
            if value:
                request.headers["Authorization"] = f"Bearer {value}"
            yield request

    lock = asyncio.Lock()
    running: set[asyncio.Task[None]] = set()

    async def write(text: str) -> None:
        async with lock:
            sys.stdout.write(text + "\n")
            sys.stdout.flush()

    async with httpx.AsyncClient(auth=Bearer(), timeout=None) as http:

        async def forward(line: str) -> None:
            response = await http.post(
                url,
                content=line,
                headers={"content-type": "application/json"},
            )
            if response.status_code == 204:
                return
            if response.status_code >= 400:
                detail = response.json().get("detail", response.text)
                raise RuntimeError(
                    f"daemon error {response.status_code}: {detail}"
                )
            await write(response.text)

        async with anyio.wrap_file(sys.stdin) as stdin:
            async for line in stdin:
                if not line.strip():
                    continue
                try:
                    message = json.loads(line)
                except ValueError:
                    await write(
                        json.dumps(
                            error_response(
                                None, RPC_PARSE_ERROR, "parse error"
                            )
                        )
                    )
                    continue
                if (
                    isinstance(message, dict)
                    and message.get("method") == CANCEL_REQUEST
                ):
                    await forward(line)
                    continue
                task = asyncio.create_task(forward(line))
                running.add(task)
                task.add_done_callback(running.discard)
        if running:
            await asyncio.gather(*running)
