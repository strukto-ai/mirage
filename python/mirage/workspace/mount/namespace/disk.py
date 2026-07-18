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

from collections.abc import Iterable
from typing import Any

from mirage.workspace.mount.namespace.store import NamespaceStore, NodeFields
from mirage.workspace.session.disk import DiskRecordClient

NAMESPACE_RECORD = "namespace"


class DiskNamespaceStore(NamespaceStore):
    """NamespaceStore backed by one ``namespace.json`` per workspace.

    The whole plane is one human-readable record
    ``{"nodes": {path: fields}, "user": ...}``: the namespace is bound
    to the workspace, so it serializes as one JSON file, not per-node
    files. Read-modify-writes take the record's lockfile so concurrent
    local processes never lose a node upsert; the write itself stays
    tmp-then-rename atomic, so readers never see a torn file.
    """

    def __init__(self, root: str) -> None:
        self._records = DiskRecordClient(root, "")

    async def _state(self) -> dict[str, Any]:
        fields, _ = await self._records.get(NAMESPACE_RECORD)
        return fields if fields is not None else {"nodes": {}, "user": None}

    async def load(self) -> dict[str, NodeFields]:
        return dict((await self._state()).get("nodes", {}))

    async def set(self, path: str, fields: NodeFields) -> None:
        fd = await self._records.lock(NAMESPACE_RECORD)
        try:
            state = await self._state()
            state.setdefault("nodes", {})[path] = dict(fields)
            await self._records.put(NAMESPACE_RECORD, state)
        finally:
            await self._records.unlock(NAMESPACE_RECORD, fd)

    async def delete(self, paths: Iterable[str]) -> None:
        fd = await self._records.lock(NAMESPACE_RECORD)
        try:
            state = await self._state()
            nodes = state.setdefault("nodes", {})
            for path in paths:
                nodes.pop(path, None)
            await self._records.put(NAMESPACE_RECORD, state)
        finally:
            await self._records.unlock(NAMESPACE_RECORD, fd)

    async def replace_all(self, entries: dict[str, NodeFields]) -> None:
        fd = await self._records.lock(NAMESPACE_RECORD)
        try:
            state = await self._state()
            state["nodes"] = {
                path: dict(fields)
                for path, fields in entries.items()
            }
            await self._records.put(NAMESPACE_RECORD, state)
        finally:
            await self._records.unlock(NAMESPACE_RECORD, fd)

    async def load_user(self) -> str | None:
        user = (await self._state()).get("user")
        return user if isinstance(user, str) else None

    async def set_user(self, user: str) -> None:
        fd = await self._records.lock(NAMESPACE_RECORD)
        try:
            state = await self._state()
            state["user"] = user
            await self._records.put(NAMESPACE_RECORD, state)
        finally:
            await self._records.unlock(NAMESPACE_RECORD, fd)

    async def clear(self) -> None:
        fd = await self._records.lock(NAMESPACE_RECORD)
        try:
            await self._records.put(NAMESPACE_RECORD, {
                "nodes": {},
                "user": None
            })
        finally:
            await self._records.unlock(NAMESPACE_RECORD, fd)

    async def close(self) -> None:
        return None
