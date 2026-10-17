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

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.msgraph.drive import write_item
from mirage.core.sharepoint.resolve import drive_loc, resolve_item
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def create(accessor: SharePointAccessor, path: PathSpec) -> None:
    """Create an empty file.

    Not a delegation to ``write_bytes``: that records the op as "write",
    so a guest creating a file and one writing one would be the same row
    in the ledger.

    Args:
        accessor (SharePointAccessor): SharePoint accessor.
        path (PathSpec): the file to create.
    """
    resolved = await resolve_item(accessor, path)
    timer = start_op()
    await write_item(
        accessor, drive_loc(accessor.config, resolved, path.vfs_path), b""
    )
    record("create", path.virtual, "sharepoint", 0, timer)
