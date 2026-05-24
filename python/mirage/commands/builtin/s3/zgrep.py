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
from mirage.commands.builtin.generic.zgrep import zgrep as generic_zgrep
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.s3.glob import resolve_glob
from mirage.core.s3.read import read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("zgrep", resource="s3", spec=SPECS["zgrep"])
async def zgrep(
    accessor: S3Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    i: bool = False,
    c: bool = False,
    args_l: bool = False,
    n: bool = False,
    v: bool = False,
    e: str | None = None,
    E: bool = False,
    F: bool = False,
    H: bool = False,
    h: bool = False,
    m: str | None = None,
    o: bool = False,
    q: bool = False,
    w: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    raw_pattern = e if e is not None else (texts[0] if texts else "")
    if paths:
        paths = await resolve_glob(accessor, paths, index)
    else:
        paths = []
    return await generic_zgrep(paths,
                               pattern=raw_pattern,
                               read_bytes=read_bytes,
                               accessor=accessor,
                               stdin=stdin,
                               ignore_case=i,
                               invert=v,
                               count=c,
                               files_only=args_l,
                               line_numbers=n,
                               extended=E,
                               fixed=F,
                               force_filename=H,
                               suppress_filename=h,
                               max_count=int(m) if m is not None else None,
                               only_matching=o,
                               quiet=q,
                               whole_word=w)
