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
from mirage.commands.builtin.generic.zip_cmd import zip_cmd as generic_zip
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation, bound_op)
from mirage.commands.builtin.generic_bind.archive_io import walk_of
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView, MountView
from mirage.types import PathSpec


async def zip_cmd(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    r: bool = False,
    j: bool = False,
    q: bool = False,
    y: bool = False,
    x: list[str] | None = None,
    index: IndexCacheStore = NULL_INDEX,
    links: LinkView | None = None,
    mounts: MountView | None = None,
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor) or not paths:
        raise ValueError("zip: usage: zip archive.zip file1 [file2 ...]")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_zip(paths,
                             read_bytes=bound_op(ops.read_bytes, accessor,
                                                 index),
                             write_bytes=partial(ops.require(Operation.WRITE),
                                                 accessor),
                             stat=partial(ops.stat, accessor, index=index),
                             walk=walk_of(ops, accessor, index),
                             r=r,
                             j=j,
                             q=q,
                             y=y,
                             x=x,
                             links=links,
                             mounts=mounts)


BUILDER = Builder('zip',
                  zip_cmd,
                  write=True,
                  requirements=frozenset({Operation.WRITE}))
