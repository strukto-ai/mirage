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
from mirage.commands.builtin.generic.cp import cp as generic_cp
from mirage.commands.builtin.generic_bind.adapter import Builder, CommandIO
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def cp(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    r: bool = False,
    R: bool = False,
    a: bool = False,
    f: bool = False,
    n: bool = False,
    v: bool = False,
    index: IndexCacheStore | None = None,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor) or len(paths) < 2:
        raise ValueError("cp: requires src and dst")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_cp(paths,
                            copy=partial(ops.copy, accessor),
                            find=partial(ops.find, accessor),
                            find_type="f",
                            stat=partial(ops.stat, accessor),
                            recursive=r or R or a,
                            n=n,
                            v=v,
                            index=index)


BUILDER = Builder('cp', cp, None, True, None, ('copy', 'find'))
