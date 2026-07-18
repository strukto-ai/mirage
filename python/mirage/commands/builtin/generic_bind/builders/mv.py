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
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.mv import mv as generic_mv
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation)
from mirage.io.types import ByteSource, IOResult
from mirage.types import NativeMove, PathSpec


async def mv(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    f: bool = False,
    n: bool = False,
    v: bool = False,
    index: IndexCacheStore | None = None,
    **kwargs: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor) or len(paths) < 2:
        raise ValueError("mv: requires src and dst")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_mv(
        paths,
        strategy=NativeMove(
            rename=partial(ops.require(Operation.RENAME), accessor)),
        stat=partial(ops.stat, accessor),
        n=n,
        v=v,
        index=index)


BUILDER = Builder('mv',
                  mv,
                  write=True,
                  requirements=frozenset({Operation.RENAME}))
