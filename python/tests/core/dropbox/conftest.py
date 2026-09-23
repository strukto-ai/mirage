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

import pytest

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.client import DropboxApiError, DropboxTokenManager
from mirage.vfs.dropbox.config import DropboxConfig


class FakeDropboxRpc:
    """A ``dropbox_rpc`` stand-in that pages ``/files/list_folder``.

    Stands in for the transport rather than for ``list_folder`` itself,
    because the walk is what a probe has to bound and only the real
    ``list_folder`` performs it: a stub in its place answers in one call
    whatever the caller asked for, so it cannot tell a bounded probe from
    an unbounded one.

    Pages every request on the limit the first one carried, as the real
    API does (the cursor retains the original request's parameters), and
    records both the cap each caller asked for and how many requests the
    walk actually made. ``page_size`` cannot express a bound on the walk:
    it caps the page, not the walk, so a small page turns a listing of a
    large folder into more requests rather than fewer.

    Args:
        entries (list[dict] | None): the folder's listing.
        metadata (dict | None): what ``/files/get_metadata`` answers.
        move_errors (list[DropboxApiError | None] | None): one entry per
            ``/files/move_v2`` call; a ``DropboxApiError`` is raised.
    """

    def __init__(
        self,
        entries: list[dict[str, Any]] | None = None,
        metadata: dict[str, Any] | None = None,
        move_errors: list[DropboxApiError | None] | None = None,
    ) -> None:
        self.entries = list(entries or [])
        self.metadata = metadata
        self.move_errors = list(move_errors or [])
        # Every `limit` a caller asked for, so a test can pin that an
        # emptiness probe is bounded, and the request count, which is the
        # half an unbounded walk gets wrong.
        self.list_limits: list[int] = []
        self.list_requests = 0
        self.deleted: list[str] = []
        self.moves: list[tuple[str, str]] = []
        self._cursors: dict[str, list[dict[str, Any]]] = {}
        self._limits: dict[str, int] = {}

    def _page(self, rest: list[dict[str, Any]], limit: int) -> dict[str, Any]:
        self.list_requests += 1
        head, tail = rest[:limit], rest[limit:]
        token = f"cursor-{len(self._cursors)}"
        self._cursors[token] = tail
        self._limits[token] = limit
        return {"entries": head, "cursor": token, "has_more": bool(tail)}

    async def __call__(self, tm: DropboxTokenManager, endpoint: str,
                       body: dict[str, Any]) -> dict[str, Any]:
        if endpoint == "/files/list_folder":
            limit = int(body.get("limit") or 2000)
            self.list_limits.append(limit)
            self._cursors = {}
            self._limits = {}
            return self._page(self.entries, limit)
        if endpoint == "/files/list_folder/continue":
            token = body["cursor"]
            return self._page(self._cursors.pop(token), self._limits[token])
        if endpoint == "/files/get_metadata":
            if self.metadata is None:
                raise DropboxApiError("nf", 409, "path/not_found/...")
            return self.metadata
        if endpoint == "/files/delete_v2":
            self.deleted.append(body["path"])
            return {}
        if endpoint == "/files/move_v2":
            self.moves.append((body["from_path"], body["to_path"]))
            error = (self.move_errors.pop(0) if self.move_errors else None)
            if error is not None:
                raise error
            return {}
        raise AssertionError(f"unexpected endpoint {endpoint}")


@pytest.fixture
def dropbox_accessor() -> DropboxAccessor:
    config = DropboxConfig(client_id="c", client_secret="s", refresh_token="r")
    return DropboxAccessor(config, DropboxTokenManager(config))
