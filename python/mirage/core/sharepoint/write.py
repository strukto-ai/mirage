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
from mirage.cache.context import settle_after_write, write_generation
from mirage.core.msgraph.drive import write_item
from mirage.core.sharepoint.resolve import drive_loc, resolve_item
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def write_bytes(
    accessor: SharePointAccessor, path: PathSpec, data: bytes
) -> None:
    resolved = await resolve_item(accessor, path)
    timer = start_op()
    started = write_generation()
    receipt = await write_item(
        accessor.config,
        drive_loc(accessor.config, resolved, path.vfs_path),
        data,
        session=accessor.pool,
    )
    record("write", path.virtual, "sharepoint", len(data), timer)
    await settle_after_write(path, data, receipt, started)
