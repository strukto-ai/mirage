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

from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field

from mirage.cache.context import push_cache_manager
from mirage.cache.types import WriteReceipt
from mirage.types import FileStat, PathSpec


@dataclass
class Settled:
    path: str
    data: bytes
    receipt: WriteReceipt | None
    started: int | None


@dataclass
class SettleRecorder:
    """A cache manager that records what a core mutator reports.

    ``generation`` is fixed, so a writer that notes it before the upload
    hands the same number to ``settle_after_write``.
    """

    generation: int = 5
    settled: list[Settled] = field(default_factory=list)
    writes: list[str] = field(default_factory=list)

    async def settle_after_write(
        self,
        path: PathSpec,
        data: bytes,
        receipt: WriteReceipt | None,
        started: int | None,
    ) -> None:
        self.settled.append(Settled(path.virtual, data, receipt, started))

    async def invalidate_after_write(self, path: PathSpec) -> None:
        self.writes.append(path.virtual)

    async def invalidate_after_unlink(self, path: PathSpec) -> None:
        return None

    async def invalidate_subtree(self, path: PathSpec) -> None:
        return None

    async def invalidate_ancestors(self, path: PathSpec) -> None:
        return None

    async def cached_bytes(self, path: PathSpec) -> bytes | None:
        return None

    async def read_through(
        self, path: PathSpec, fetch: Callable[[], Awaitable[bytes]]
    ) -> bytes:
        return await fetch()

    async def cached_size(self, path: PathSpec) -> int | None:
        return None

    def listing_trusted(self, folder: str) -> bool:
        return False

    def probed_stat(self, path: PathSpec) -> FileStat | None:
        return None


@contextmanager
def settling() -> Iterator[SettleRecorder]:
    recorder = SettleRecorder()
    prev = push_cache_manager(recorder)
    try:
        yield recorder
    finally:
        push_cache_manager(prev)
