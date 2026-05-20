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
from mirage.commands.builtin.generic.tree import tree as generic_tree
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gdrive.glob import resolve_glob
from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tree", resource="gdrive", spec=SPECS["tree"])
async def tree(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    L: str | None = None,
    a: bool = False,
    args_I: str | None = None,
    d: bool = False,
    P: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_glob(accessor, paths, index)
    return await generic_tree(
        paths[0],
        readdir=partial(readdir, accessor),
        stat=partial(stat, accessor),
        max_depth=int(L) if L is not None else None,
        show_hidden=a,
        ignore_pattern=args_I,
        dirs_only=d,
        match_pattern=P,
        index=index,
    )
