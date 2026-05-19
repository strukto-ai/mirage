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

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.unzip import unzip as generic_unzip
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.ram.glob import resolve_glob
from mirage.core.ram.mkdir import mkdir as _mkdir
from mirage.core.ram.read import read_bytes as _read_bytes
from mirage.core.ram.write import write_bytes as _write_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("unzip", resource="ram", spec=SPECS["unzip"], write=True)
async def unzip(
    accessor: RAMAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    o: bool = False,
    args_l: bool = False,
    d: str | None = None,
    q: bool = False,
    p: bool = False,
    t: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.store is None or not paths:
        raise ValueError("unzip: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    return await generic_unzip(paths,
                               read_bytes=_read_bytes,
                               write_bytes=_write_bytes,
                               mkdir_fn=_mkdir,
                               accessor=accessor,
                               o=o,
                               args_l=args_l,
                               d=d,
                               q=q,
                               p=p,
                               t=t)
