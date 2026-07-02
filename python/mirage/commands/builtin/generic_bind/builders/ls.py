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
from mirage.commands.builtin.generic.ls import ls as generic_ls
from mirage.commands.builtin.generic_bind.adapter import Builder, CommandIO
from mirage.io.types import ByteSource, IOResult
from mirage.types import LsSortBy, PathSpec


async def ls(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    args_l: bool = False,
    args_1: bool = False,
    a: bool = False,
    A: bool = False,
    h: bool = False,
    t: bool = False,
    S: bool = False,
    r: bool = False,
    R: bool = False,
    d: bool = False,
    F: bool = False,
    index: IndexCacheStore | None = None,
    cwd: PathSpec | str = "/",
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("ls: no resource")
    if not paths:
        cwd_str = cwd.virtual if isinstance(cwd, PathSpec) else cwd
        cwd_rp = (cwd.resource_path
                  if isinstance(cwd, PathSpec) else cwd.strip("/"))
        paths = [
            PathSpec(virtual=cwd_str,
                     directory=cwd_str,
                     resolved=False,
                     resource_path=cwd_rp)
        ]
    paths = await ops.resolve_glob(accessor, paths, index)
    sort_by = LsSortBy.TIME if t else LsSortBy.SIZE if S else LsSortBy.NAME
    return await generic_ls(
        paths,
        readdir=partial(ops.readdir, accessor),
        stat=partial(ops.stat, accessor),
        long=args_l,
        one_per_line=args_1,
        all_files=a or A,
        human=h,
        sort_by=sort_by,
        reverse=r,
        recursive=R,
        list_dir=d,
        classify=F,
        index=index,
    )


BUILDER = Builder('ls', ls, None, False, None)
