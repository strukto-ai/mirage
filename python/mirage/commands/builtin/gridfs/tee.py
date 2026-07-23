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

from mirage.accessor.gridfs import GridFSAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.tee import parse_flags, write_output
from mirage.commands.builtin.gridfs.io import resolve_glob
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gridfs.stream import read_stream
from mirage.core.gridfs.write import write_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tee", resource="gridfs", spec=SPECS["tee"], write=True)
async def tee(
    accessor: GridFSAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    index: IndexCacheStore,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("tee: missing operand")
    try:
        parsed = parse_flags(flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=(str(exc) + "\n").encode())
    paths = await resolve_glob(accessor, paths, index)
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raw = (" ".join(texts)).encode() if texts else b""
    write_data = raw
    if parsed.append:
        try:
            existing = b""
            async for chunk in read_stream(accessor, paths[0], index=index):
                existing += chunk
            write_data = existing + raw
        except FileNotFoundError:
            # appending to a missing object starts from empty
            pass
    return await write_output(partial(write_bytes, accessor), paths[0],
                              write_data, raw)
