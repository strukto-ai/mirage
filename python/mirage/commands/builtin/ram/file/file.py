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

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.file import file_cmd as generic_file
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.ram.glob import resolve_glob
from mirage.core.ram.read import read_bytes
from mirage.core.ram.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("file", resource="ram", spec=SPECS["file"])
async def file(
    accessor: RAMAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    b: bool = False,
    i: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.store is None or not paths:
        raise ValueError("file: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    return await generic_file(paths,
                              read_bytes=read_bytes,
                              stat_fn=stat,
                              accessor=accessor,
                              b=b,
                              i=i)
