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
from mirage.commands.builtin.generic.du import du_multi
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gdrive.glob import resolve_glob
from mirage.core.gdrive.readdir import readdir as _readdir
from mirage.core.gdrive.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import FileType, PathSpec


async def _du_walk(
    accessor: GDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore | None,
) -> int:
    total = 0
    try:
        s = await _stat(accessor, path, index)
        if s.type != FileType.DIRECTORY:
            return s.size or 0
    except (FileNotFoundError, ValueError):
        return 0
    try:
        children = await _readdir(accessor, path, index)
    except (FileNotFoundError, ValueError):
        return 0
    for child in children:
        child_spec = PathSpec(original=child,
                              directory=child,
                              resolved=False,
                              prefix=path.prefix)
        total += await _du_walk(accessor, child_spec, index)
    return total


async def du_provision(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    return await metadata_provision(
        "du " + " ".join(p.original if isinstance(p, PathSpec) else p
                         for p in paths),
        index=index)


@command("du", resource="gdrive", spec=SPECS["du"], provision=du_provision)
async def du(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    h: bool = False,
    s: bool = False,
    a: bool = False,
    max_depth: str | None = None,
    c: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_glob(accessor, paths, index)
    out = await du_multi(
        paths,
        compute_total=partial(_du_walk, accessor, index=index),
        h=h,
        s=s,
        a=a,
        c=c,
    )
    return out, IOResult()
