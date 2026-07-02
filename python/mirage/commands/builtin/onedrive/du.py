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

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.du import du_multi
from mirage.commands.builtin.generic_bind.provision import metadata_provision
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.onedrive.du import du as du_impl
from mirage.core.onedrive.du import du_all as du_all_impl
from mirage.core.onedrive.glob import resolve_glob
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("du",
         resource="onedrive",
         spec=SPECS["du"],
         provision=metadata_provision)
async def du(
    accessor: OneDriveAccessor,
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
        compute_total=partial(du_impl, accessor),
        compute_all=partial(du_all_impl, accessor),
        h=h,
        s=s,
        a=a,
        max_depth=int(max_depth) if max_depth is not None else None,
        c=c,
    )
    return out, IOResult()
