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

from mirage.accessor.disk import DiskAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.disk.glob import resolve_glob
from mirage.core.disk.read import read_bytes
from mirage.core.disk.stat import stat as local_stat
from mirage.core.filetype.feather import ls as feather_ls
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("ls", resource="disk", spec=SPECS["ls"], filetype=".arrow")
@command("ls", resource="disk", spec=SPECS["ls"], filetype=".ipc")
@command("ls", resource="disk", spec=SPECS["ls"], filetype=".feather")
async def ls_feather(
    accessor: DiskAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    args_l: bool = False,
    a: bool = False,
    A: bool = False,
    h: bool = False,
    t: bool = False,
    S: bool = False,
    r: bool = False,
    R: bool = False,
    d: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.root is None or not paths:
        raise ValueError("ls: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    try:
        s = await local_stat(accessor, paths[0])
        raw = await read_bytes(accessor, paths[0])
        rows, cols = feather_ls(raw)
        size = s.size or 0
        line = (f"feather\t{size}\t{rows} rows\t{cols} cols"
                f"\t{s.modified or ''}\t{s.name}")
        return line.encode(), IOResult(reads={paths[0].strip_prefix: raw},
                                       cache=[paths[0].strip_prefix])
    except Exception:
        s = await local_stat(accessor, paths[0])
        line = (f"feather\t{s.size or 0}\t\t"
                f"\t{s.modified or ''}\t{s.name}")
        return line.encode(), IOResult()
