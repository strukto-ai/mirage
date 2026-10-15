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
from mirage.core.bin.read import read
from mirage.types import FileStat, FileType, PathSpec

# A program's file is executable by everyone, and the directory holding
# them is the usual /usr/bin.
PROGRAM_MODE = 0o755


async def stat(accessor: BinAccessor, path: PathSpec) -> FileStat:
    """Stat the view root or one program's file.

    Args:
        accessor (BinAccessor): Accessor holding the lookup.
        path (PathSpec): Virtual path under the view.

    Returns:
        FileStat: The directory, or an executable file sized to its stub.
    """
    key = path.mount_path.strip("/")
    if key == "":
        return FileStat(name="bin", type=FileType.DIRECTORY, mode=PROGRAM_MODE)
    data = await read(accessor, path)
    return FileStat(
        name=key, size=len(data), type=FileType.FILE, mode=PROGRAM_MODE
    )
