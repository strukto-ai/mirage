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

from mirage.cache.types import WriteContext
from mirage.types import PathSpec


class KeptVersions:
    """A write context whose store holds ``s0`` and records what it keeps.

    For a refusal test where the store's version, the write's and the one
    sent all differ, so which one a refusal keeps is visible.
    """

    def __init__(self, vfs: str) -> None:
        self.vfs = vfs
        self.kept: list[str] = []

    async def keep(self, _path: PathSpec, version: str) -> None:
        self.kept.append(version)

    async def held(self, _path: PathSpec) -> str | None:
        return "s0"

    async def held_all(self, paths: list[PathSpec]) -> list[str | None]:
        return ["s0"] * len(paths)

    async def drop(self, _path: PathSpec) -> None:
        return None

    def context(self) -> WriteContext:
        return WriteContext(
            vfs=self.vfs,
            conditions=frozenset({"put", "copy", "delete"}),
            read_version=self.held,
            read_versions=self.held_all,
            drop=self.drop,
            keep=self.keep,
        )
