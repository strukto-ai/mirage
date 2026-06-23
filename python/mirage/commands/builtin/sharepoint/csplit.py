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

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.csplit import csplit as generic_csplit
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.sharepoint.glob import resolve_glob
from mirage.core.sharepoint.read import read_bytes
from mirage.core.sharepoint.write import write_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("csplit", resource="sharepoint", spec=SPECS["csplit"], write=True)
async def csplit(
    accessor: SharePointAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    f: str | None = None,
    n: str | None = None,
    b: str | None = None,
    k: bool = False,
    s: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
    else:
        paths = []
    return await generic_csplit(paths,
                                texts,
                                read_bytes=read_bytes,
                                write_bytes=write_bytes,
                                accessor=accessor,
                                stdin=stdin,
                                prefix=f or "xx",
                                digits=int(n) if n else 2,
                                suffix_format=b,
                                keep_on_error=k,
                                silent=s)
