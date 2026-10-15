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

from collections.abc import AsyncIterator

from mirage.errors.fs import eisdir, enoent
from mirage.types import FileStat, FileType, PathSpec


def file_entry(path: PathSpec, entry: FileStat | None) -> FileStat:
    """What is at the file ``path``, as its folder's listing named it.

    Args:
        path (PathSpec): the file.
        entry (FileStat | None): what is at the path.

    Raises:
        FileNotFoundError: nothing is there.
        IsADirectoryError: a folder is.
    """
    if not path.mount_path.strip("/"):
        raise eisdir(path.virtual)
    if entry is None:
        raise enoent(path.virtual)
    if entry.type is FileType.DIRECTORY:
        raise eisdir(path.virtual)
    return entry


async def join_lines(parts: AsyncIterator[str]) -> AsyncIterator[bytes]:
    """Stream a document's parts joined by newlines, the way it renders.

    Args:
        parts (AsyncIterator[str]): the document's parts in order.
    """
    first = True
    async for part in parts:
        if not first:
            yield b"\n"
        first = False
        yield part.encode()
