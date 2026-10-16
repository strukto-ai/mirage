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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive import NATIVE_RESOURCE_TYPES
from mirage.core.gdrive.readdir import live_row
from mirage.core.gdrive.resolve import eacces_on_denied
from mirage.core.gdrive.write import write
from mirage.core.google.drive import download_file
from mirage.errors.fs import eisdir, enotsup
from mirage.types import FileStat, FileType, PathSpec


@eacces_on_denied
async def truncate(
    accessor: GDriveAccessor,
    path: PathSpec,
    length: int,
    no_create: bool = False,
    entry: FileStat | None = None,
    parent: FileStat | None = None,
) -> None:
    if no_create:
        raise enotsup("gdrive", "truncate --no-create", path)
    entry = await live_row(accessor, path, entry)
    if entry is not None and entry.type is FileType.DIRECTORY:
        raise eisdir(path.virtual)
    if (
        entry is None
        or entry.extra.get("resource_type") in NATIVE_RESOURCE_TYPES
    ):
        data = b""
    else:
        data = await download_file(
            accessor.token_manager, entry.extra["file_id"]
        )
    if length <= len(data):
        new = data[:length]
    else:
        new = data + b"\x00" * (length - len(data))
    await write(accessor, path, new, entry=entry, parent=parent)
