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

from mirage.accessor.bin import BinAccessor
from mirage.core.bin.stat import stat
from mirage.errors.fs import enoent, enotdir
from mirage.types import FileStat, PathSpec


async def readdir(accessor: BinAccessor, path: PathSpec) -> list[FileStat]:
    """List one file per program, each as its stat answers it.

    Args:
        accessor (BinAccessor): Accessor holding the lookup.
        path (PathSpec): Virtual path; only the view root lists.

    Returns:
        list[FileStat]: The programs' rows, sorted.
    """
    key = path.mount_path.strip("/")
    if key != "":
        if "/" not in key and accessor.note(key) is not None:
            raise enotdir(path)
        raise enoent(path)
    base = path.virtual.rstrip("/")
    return [
        await stat(
            accessor,
            PathSpec(
                virtual=f"{base}/{name}", directory=base or "/", vfs_path=name
            ),
        )
        for name in accessor.programs()
    ]
