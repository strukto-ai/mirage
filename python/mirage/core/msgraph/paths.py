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

from typing import Any, Protocol

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.msgraph.client import GraphError, graph_get
from mirage.errors.fs import enoent


class DrivePath(Protocol):
    @property
    def path(self) -> str: ...

    @property
    def virt(self) -> str: ...

    def item_at(self, path: str, action: str = "") -> str: ...


async def check_item(
    accessor: OneDriveAccessor | SharePointAccessor,
    loc: DrivePath,
    virtual: str | None = None,
    params: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    """Validate every existing caller-controlled drive path component.

    Args:
        accessor (OneDriveAccessor | SharePointAccessor): backend accessor.
        loc (DrivePath): backend address and virtual relative path.
        virtual (str | None): complete operand for errors when available.
        params (dict[str, str] | None): metadata fields needed for the leaf.
    """
    parts = loc.path.strip("/").split("/") if loc.path.strip("/") else []
    visible = [part for part in loc.virt.split("/") if part]
    start = max(0, len(parts) - len(visible))
    entry = None
    for i in range(start, len(parts)):
        try:
            url = loc.item_at("/".join(parts[: i + 1]))
            entry = await graph_get(
                accessor, url, params=params if i == len(parts) - 1 else None
            )
        except GraphError as exc:
            if exc.status == 404:
                return None
            raise
        named = entry.get("name")
        if isinstance(named, str) and named != parts[i]:
            raise enoent(virtual or "/" + loc.virt.strip("/"))
    return entry
