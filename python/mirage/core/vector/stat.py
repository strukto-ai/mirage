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

from mirage.core.hierarchy.bind import per_accessor
from mirage.core.hierarchy.probe import A
from mirage.core.hierarchy.read import ReadFn
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import StatHook
from mirage.core.hierarchy.stat import make_stat as hierarchy_stat
from mirage.core.vector.scope import table_of
from mirage.core.vector.types import VectorTree
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec, StatFn


def _name_of(path: PathSpec) -> str:
    stripped = path.virtual.rstrip("/")
    return stripped.rsplit("/", 1)[-1] or "/"


def make_stat(tree: VectorTree[A], read: ReadFn) -> StatFn:
    """Build a store's stat: a group proves its table, a row its bytes.

    A row a listing names is answered by the mount from that listing,
    which carries its rendered size; one no listing names is rendered
    here, so the size is exact either way.

    Args:
        tree (VectorTree[A]): the store's hooks.
        read (ReadFn): the store's read, sizing a row.
    """

    async def table_guard(
        accessor: A, match: ScopeMatch, virtual: str
    ) -> None:
        table = table_of(tree.pinned(accessor), match)
        if not await tree.table_exists(accessor, table):
            raise enoent(virtual)

    async def stat_row(
        accessor: A,
        match: ScopeMatch,
        path: PathSpec,
        entry: FileStat | None,
        parent: FileStat | None,
    ) -> FileStat:
        await table_guard(accessor, match, path.virtual)
        return FileStat(
            name=_name_of(path),
            size=len(await read(accessor, path)),
            type=FileType.FILE,
            content=match.scope.filetype if match.scope is not None else None,
        )

    overrides: dict[str, StatHook[A]] = {
        kind: stat_row for kind in tree.readers
    }

    def build(accessor: A) -> StatFn:
        return hierarchy_stat(
            tree.detect(accessor),
            guards={"group": table_guard},
            overrides=overrides,
        )

    stat_for = per_accessor(build)

    async def stat(accessor: A, path: PathSpec) -> FileStat:
        return await stat_for(accessor)(accessor, path)

    return stat
