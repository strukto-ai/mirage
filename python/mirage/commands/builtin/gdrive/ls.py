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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.gdrive._provision import metadata_provision
from mirage.commands.builtin.generic.ls import ls as generic_ls
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gdrive.glob import resolve_glob
from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import LsSortBy, PathSpec


async def ls_provision(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    return await metadata_provision(
        "ls " + " ".join(p.original if isinstance(p, PathSpec) else p
                         for p in paths),
        index=index)


@command("ls", resource="gdrive", spec=SPECS["ls"], provision=ls_provision)
async def ls(
    accessor: GDriveAccessor,
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
    index: IndexCacheStore = None,
    cwd: PathSpec | str = "/",
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        cwd_str = cwd.original if isinstance(cwd, PathSpec) else cwd
        cwd_prefix = cwd.prefix if isinstance(cwd, PathSpec) else ""
        paths = [
            PathSpec(original=cwd_str,
                     directory=cwd_str,
                     resolved=False,
                     prefix=cwd_prefix)
        ]
    paths = await resolve_glob(accessor, paths, index)
    sort_by = LsSortBy.TIME if t else LsSortBy.SIZE if S else LsSortBy.NAME
    return await generic_ls(
        paths,
        readdir=partial(readdir, accessor),
        stat=partial(stat, accessor),
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
        trailing_newline=True,
    )
