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

from collections.abc import Awaitable, Callable

from mirage.core.hierarchy.bind import per_accessor
from mirage.core.hierarchy.probe import A, ReaddirFn
from mirage.core.hierarchy.readdir import Listed, Lister
from mirage.core.hierarchy.readdir import make_readdir as hierarchy_readdir
from mirage.core.hierarchy.scope import ROOT, ScopeMatch
from mirage.core.vector.types import VectorTree
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.glob_walk import has_glob_prefix

PATTERN_KINDS = {ROOT: has_glob_prefix, "group": has_glob_prefix}


def make_readdir(
    tree: VectorTree[A],
) -> Callable[[A, PathSpec], Awaitable[Listed]]:
    """Build a store's readdir: the catalog at the root, its own below.

    Args:
        tree (VectorTree[A]): the store's hooks.
    """

    async def list_root(accessor: A, match: ScopeMatch) -> Listed | None:
        if tree.pinned(accessor):
            return await tree.children(accessor, match)
        # Table names come from the catalog, not from a capped query, so
        # a glob here has nothing to narrow.
        return [
            FileStat(name=name, type=FileType.DIRECTORY)
            for name in await tree.list_tables(accessor)
        ]

    listers: dict[str, Lister[A]] = {ROOT: list_root, "group": tree.children}

    def build(accessor: A) -> ReaddirFn[A]:
        return hierarchy_readdir(
            tree.detect(accessor), listers=listers, pattern_kinds=PATTERN_KINDS
        )

    readdir_for = per_accessor(build)

    async def readdir(accessor: A, path_spec: PathSpec) -> Listed:
        return await readdir_for(accessor)(accessor, path_spec)

    return readdir
