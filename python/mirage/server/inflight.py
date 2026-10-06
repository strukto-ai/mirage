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
from collections.abc import Callable

from mirage.types import JsonValue


def rpc_messages(body: bytes) -> list[dict[str, JsonValue]]:
    """The JSON-RPC messages a request body carries, one or a batch.

    Args:
        body (bytes): the raw request body.

    Returns:
        list[dict[str, JsonValue]]: the messages; empty for a body that
            is not JSON-RPC.
    """
    try:
        parsed = json.loads(body)
    except ValueError:
        return []
    items = parsed if isinstance(parsed, list) else [parsed]
    return [item for item in items if isinstance(item, dict)]


class InFlight:
    """Calls still running, so a cancel that arrives on another request
    reaches them.

    A stateless endpoint answers each HTTP request on its own, so a
    client's cancel (MCP's ``notifications/cancelled``, RPC's
    ``$/cancelRequest``) comes in on a request of its own. Calls are
    keyed by the workspace, the session and the request id the client
    chose; two callers in one session that reuse an id each hold their
    own call under it, and a cancel for the id stops both.
    """

    def __init__(self) -> None:
        self._running: dict[str, list[Callable[[], bool]]] = {}

    @staticmethod
    def key(workspace_id: str, session_id: str, request_id: JsonValue) -> str:
        """The key a call runs under.

        Args:
            workspace_id (str): the workspace.
            session_id (str): the session the call acts as.
            request_id (JsonValue): the JSON-RPC id the client chose.

        Returns:
            str: the key.
        """
        return json.dumps([workspace_id, session_id, request_id])

    def add(self, key: str, cancel: Callable[[], bool]) -> None:
        """Hold a running call.

        Args:
            key (str): the call's key.
            cancel (Callable[[], bool]): stops it.
        """
        self._running.setdefault(key, []).append(cancel)

    def discard(self, key: str, cancel: Callable[[], bool]) -> None:
        """Forget a call that settled, leaving any other under its key.

        Args:
            key (str): the call's key.
            cancel (Callable[[], bool]): what it was added with.
        """
        calls = self._running.get(key, [])
        if cancel in calls:
            calls.remove(cancel)
        if not calls:
            self._running.pop(key, None)

    def cancel(self, key: str) -> bool:
        """Stop every call running under a key.

        Args:
            key (str): the calls' key.

        Returns:
            bool: True when a call was running under the key.
        """
        calls = self._running.pop(key, [])
        for cancel in calls:
            cancel()
        return bool(calls)
