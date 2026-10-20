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
from collections.abc import Mapping
from typing import Literal, NotRequired, TypedDict

from mirage_rs import NFSServer, StreamError

from mirage.rs.errors import StreamRefusal
from mirage.types import JsonValue


class NFSRequest(TypedDict):
    """A file operation a call waits on, for the host to run on its mount
    core."""

    id: int
    op: Literal["getattr", "readdir", "read", "readlink"]
    path: str
    offset: NotRequired[int]
    size: NotRequired[int]
    after: NotRequired[str]
    limit: NotRequired[int]


class NFSEngine:
    """The mirage-rs NFSv3 server, which does no I/O of its own: the host
    feeds it each connection's bytes, runs the file operations
    ``requests`` names, and hands each result back through ``complete``.

    Args:
        export (str): the path a client mounts.
        generation (int): stamped into every file handle; a handle from
            another generation is stale.
        port (int): the port the host listens on, which the portmapper
            answers with.
    """

    def __init__(self, export: str, generation: int, port: int) -> None:
        config = {"export": export, "generation": generation, "port": port}
        try:
            self._server = NFSServer(json.dumps(config).encode())
        except StreamError as exc:
            raise StreamRefusal(str(exc.args[0]), b"") from exc

    def feed(self, conn: int, data: bytes) -> bytes:
        """Take what connection ``conn`` sent.

        Args:
            conn (int): the connection.
            data (bytes): the bytes it sent.

        Returns:
            bytes: the replies it answers at once.
        """
        try:
            return self._server.feed(conn, data)
        except StreamError as exc:
            raise StreamRefusal(str(exc.args[0]), b"") from exc

    def requests(self) -> list[NFSRequest]:
        """The file operations calls wait on, each with its ``id``."""
        found: list[NFSRequest] = json.loads(self._server.requests())
        return found

    def complete(
        self,
        request_id: int,
        reply: Mapping[str, JsonValue],
        data: bytes = b"",
    ) -> tuple[int | None, bytes]:
        """Hand back one request's result.

        Args:
            request_id (int): the request's ``id``.
            reply (Mapping[str, JsonValue]): ``{"error": "ENOENT"}``, or
                what it asked for (``attrs``, ``entries``, ``target``).
            data (bytes): the bytes a read returned.

        Returns:
            tuple[int | None, bytes]: the call's connection (None once it
                has closed) and its reply once it has one.
        """
        try:
            return self._server.complete(
                request_id, json.dumps(reply).encode(), data
            )
        except StreamError as exc:
            raise StreamRefusal(str(exc.args[0]), b"") from exc

    def close(self, conn: int) -> None:
        """Forget connection ``conn`` and the calls it has out.

        Args:
            conn (int): the connection.
        """
        self._server.close(conn)
