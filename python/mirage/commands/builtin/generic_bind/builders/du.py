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
from mirage.commands.builtin.generic.du import du as generic_du
from mirage.commands.builtin.generic.du import du_multi
from mirage.commands.builtin.generic_bind.adapter import Builder, CommandIO
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import rekey


async def _du_walk(ops: CommandIO, accessor: Accessor, index: IndexCacheStore,
                   path: PathSpec) -> int:
    try:
        s = await ops.stat(accessor, path, index)
    except (FileNotFoundError, ValueError):
        return 0
    if s.type != FileType.DIRECTORY:
        return s.size or 0
    total = 0
    try:
        children = await ops.readdir(accessor, path, index)
    except (FileNotFoundError, ValueError):
        return 0
    for child in children:
        child_spec = PathSpec(virtual=child,
                              directory=child,
                              resolved=False,
                              resource_path=rekey(path.virtual,
                                                  path.resource_path, child))
        total += await _du_walk(ops, accessor, index, child_spec)
    return total


async def du(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    h: bool = False,
    s: bool = False,
    a: bool = False,
    max_depth: str | None = None,
    c: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("du: no resource")
    paths = await ops.resolve_glob(accessor, paths, index)
    if not paths:
        raise ValueError("du: missing operand")
    depth = int(max_depth) if max_depth is not None else None
    if ops.du_total is None or ops.du_all is None:
        out = await du_multi(paths,
                             compute_total=partial(_du_walk, ops, accessor,
                                                   index),
                             h=h,
                             s=s,
                             a=a,
                             max_depth=depth,
                             c=c)
        return out, IOResult()
    text = await generic_du(
        paths,
        compute_total=partial(ops.du_total, accessor),
        compute_all=partial(ops.du_all, accessor),
        s=s,
        a=a,
        h=h,
        max_depth=depth,
        c=c,
    )
    return text.encode(), IOResult()


BUILDER = Builder('du', du, None, False, None)
