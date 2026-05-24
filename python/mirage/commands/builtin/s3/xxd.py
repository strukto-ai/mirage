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

from collections.abc import AsyncIterator

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.xxd import xxd as generic_xxd
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.s3.glob import resolve_glob
from mirage.core.s3.stream import read_stream
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("xxd", resource="s3", spec=SPECS["xxd"])
async def xxd(
    accessor: S3Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    p: bool = False,
    args_l: str | bool = False,
    c: str | bool = False,
    s: str | bool = False,
    g: str | bool = False,
    u: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
    else:
        paths = []
    skip = int(s) if s and s is not True else 0
    limit = int(args_l) if args_l and args_l is not True else 0
    cols = int(c) if c and c is not True else 16
    group = int(g) if g and g is not True else 2
    return await generic_xxd(paths,
                             read_stream=read_stream,
                             accessor=accessor,
                             stdin=stdin,
                             reverse=r,
                             plain=p,
                             uppercase=u,
                             cols=cols,
                             group=group,
                             skip=skip,
                             limit=limit)
