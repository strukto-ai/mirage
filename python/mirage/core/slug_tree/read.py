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

from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.slug_tree.tree import SlugTree
from mirage.core.slug_tree.types import A
from mirage.errors.fs import eisdir
from mirage.types import PathSpec


async def file_entry(
    tree: SlugTree[A], accessor: A, path: PathSpec, index: IndexCacheStore
) -> IndexEntry:
    """The index entry of a file path; a folder is EISDIR.

    Args:
        tree (SlugTree[A]): the backend's tree.
        accessor (A): the mount's accessor.
        path (PathSpec): the path to read.
        index (IndexCacheStore): the mount's index.
    """
    resolved = await tree.resolve(accessor, path, index)
    if resolved.is_dir:
        raise eisdir(path.virtual)
    return resolved.entry


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
