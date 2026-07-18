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

from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.tree import tree as generic_tree
from mirage.commands.builtin.generic_bind.adapter import Builder, CommandIO
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def tree(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    L: str | None = None,
    a: bool = False,
    args_I: str | None = None,
    d: bool = False,
    P: str | None = None,
    index: IndexCacheStore = NULL_INDEX,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("tree: no resource")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_tree(
        paths[0],
        readdir=partial(ops.readdir, accessor),
        stat=partial(ops.stat, accessor),
        max_depth=int(L) if L is not None else None,
        show_hidden=a,
        ignore_pattern=args_I,
        dirs_only=d,
        match_pattern=P,
        index=index,
    )


BUILDER = Builder('tree', tree, None, False, None)
