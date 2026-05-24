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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.cut_helper import (cut_record, parse_ranges,
                                                split_records)
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gdrive.glob import resolve_glob
from mirage.core.gdrive.read import read as gdrive_read
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("cut", resource="gdrive", spec=SPECS["cut"])
async def cut(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    f: str | None = None,
    d: str | None = None,
    c: str | None = None,
    complement: bool = False,
    z: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    field_ranges = parse_ranges(f) if f is not None else None
    char_ranges = parse_ranges(c) if c is not None else None
    delim = d if d is not None else "\t"
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        raw = await gdrive_read(accessor, paths[0], index)
    else:
        raw = await _read_stdin_async(stdin)
        if raw is None:
            raise ValueError("cut: missing operand")
    sep = b"\x00" if z else b"\n"
    out = [
        cut_record(rec, delim, field_ranges, char_ranges, complement) + sep
        for rec in split_records(raw, z)
    ]
    return b"".join(out), IOResult()
