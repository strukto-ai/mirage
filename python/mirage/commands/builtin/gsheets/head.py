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

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.head import head as generic_head
from mirage.commands.builtin.gsheets._provision import file_read_provision
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gsheets.glob import resolve_glob
from mirage.core.gsheets.read import read as gsheets_read
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def head_provision(
    accessor: GSheetsAccessor,
    paths: list[PathSpec],
    *texts: str,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor,
        paths,
        "head " + " ".join(p.original if isinstance(p, PathSpec) else p
                           for p in paths),
        index=index)


@command("head",
         resource="gsheets",
         spec=SPECS["head"],
         provision=head_provision)
async def head(
    accessor: GSheetsAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: str | None = None,
    c: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    n_int = int(n) if n is not None else None
    c_int = int(c) if c is not None else None
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        p = paths[0]
        data = await gsheets_read(accessor, p, index)
        return generic_head(data, n=n_int, c=c_int), IOResult()
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("head: missing operand")
    return generic_head(raw, n=n_int, c=c_int), IOResult()
