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
from typing import Any, Generic, TypeVar

from mirage.accessor.hf_hub import HfHubAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore

# The accessor a subclass narrows to. TypeScript spells this as an abstract
# readonly field the subclass redeclares, which its covariant property rule
# allows; python attributes are invariant, so the same narrowing has to be a
# type parameter or mypy reads every subclass as an illegal override.
from mirage.core.hf_hub.constants import SCOPE_ERROR
from mirage.core.hf_hub.exists import exists as _exists
from mirage.core.hf_hub.read import read as _read
from mirage.core.hf_hub.readdir import readdir as _readdir
from mirage.core.hf_hub.stat import stat as _stat
from mirage.core.hf_hub.stream import read_stream as _read_stream
from mirage.core.hf_hub.watch import build_delta_hook
from mirage.types import FileStat, ListingVersion, PathSpec
from mirage.vfs.base import BaseVFS
from mirage.watch.base import DeltaHook

A = TypeVar("A", bound=HfHubAccessor)


class HfHubVFS(BaseVFS, Generic[A]):
    """Everything a Hub repo mount does, for whichever repo type it is.

    Models, datasets and spaces are one API and one tree; they differ only
    in the `repo_type` their accessor sends and the prompt they carry. A
    subclass therefore declares `name`, `prompt` and the accessor class,
    and nothing else. Keeping the behaviour here rather than copying it
    three times is what the TypeScript side already does.
    """

    accessor: A
    ACCESSOR: type[A]
    caches_reads: bool = True
    # The Hub tree reports every file's exact byte size, and for an LFS
    # file that is the object's own size rather than the pointer's, so
    # no read can be short.
    sizes_always_known: bool = True
    # The index is not a cache in front of a listing, it IS the listing:
    # one recursive fetch seeds it whole. A long TTL therefore spares the
    # Hub a full re-walk rather than risking a stale row. Written as a
    # literal, the way every other VFS writes it: the spec dump reads
    # this off the source, and an imported name reads as unresolvable.
    index_ttl: float = 86_400
    supports_snapshot: bool = True
    read_revalidatable: bool = True
    # One version covers every listing: the head commit the revision
    # resolves to, asked with `revision/{rev}?expand[]=sha`, and the tree
    # is walked at that commit so the rows and the version agree. A
    # full-sha revision is checked the same way and never pinned: a branch
    # or tag named like it could take the name, and mirage does not assume
    # which one the Hub resolves.
    listing_version: ListingVersion = ListingVersion.MOUNT

    reads_ranges: bool = True
    max_glob_matches: int | None = SCOPE_ERROR

    def __init__(self, config: Any) -> None:
        super().__init__()
        self.config = config
        self.accessor = self.ACCESSOR(self.config)

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        return await _readdir(self.accessor, path, index)

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        if not offset and size is None:
            return await _read(self.accessor, path, index)
        return await _read(self.accessor, path, index, offset, size)

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        return await _stat(self.accessor, path, index)

    def read_stream(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> AsyncIterator[bytes]:
        return _read_stream(self.accessor, path, index)

    async def exists(self, path: PathSpec) -> bool:
        return await _exists(self.accessor, path)

    def delta_hook(self) -> DeltaHook:
        return build_delta_hook(self.accessor)

    def get_state(self) -> dict[str, Any]:
        return self.config_state(self.config)
