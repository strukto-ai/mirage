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
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.sharepoint.glob import resolve_glob
from mirage.core.sharepoint.stream import read_stream
from mirage.core.sharepoint.write import write_bytes
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _alpha_suffix(index: int, length: int) -> str:
    chars: list[str] = []
    for _ in range(length):
        chars.append(chr(ord("a") + index % 26))
        index //= 26
    return "".join(reversed(chars))


def _numeric_suffix(index: int, length: int) -> str:
    return str(index).zfill(length)


@command("split", resource="sharepoint", spec=SPECS["split"], write=True)
async def split(
    accessor: SharePointAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    args_l: str | None = None,
    b: str | None = None,
    n: str | None = None,
    d: bool = False,
    a: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
    prefix_name = paths[1].strip_prefix if len(paths) >= 2 else "x"
    lines_per_file = int(args_l) if args_l else (
        1000 if not b and not n else 0)
    byte_limit = int(b) if b else 0
    n_chunks = int(n) if n else 0
    suffix_len = int(a) if a else 2
    suffix_fn = _numeric_suffix if d else _alpha_suffix

    if paths:
        source: AsyncIterator[bytes] = read_stream(accessor, paths[0])
    else:
        source = _resolve_source(stdin, "split: missing input")

    writes: dict[str, bytes] = {}
    file_idx = 0

    if n_chunks > 0:
        all_data = bytearray()
        async for chunk in source:
            all_data.extend(chunk)
        total = len(all_data)
        chunk_size = max(1, (total + n_chunks - 1) // n_chunks)
        offset = 0
        for i in range(n_chunks):
            part = bytes(all_data[offset:offset + chunk_size])
            if not part:
                break
            out_path = prefix_name + suffix_fn(i, suffix_len)
            await write_bytes(accessor, out_path, part)
            writes[out_path] = part
            offset += chunk_size
    elif byte_limit > 0:
        buf = bytearray()
        async for chunk in source:
            buf.extend(chunk)
            while len(buf) >= byte_limit:
                out_path = prefix_name + suffix_fn(file_idx, suffix_len)
                data = bytes(buf[:byte_limit])
                await write_bytes(accessor, out_path, data)
                writes[out_path] = data
                buf = buf[byte_limit:]
                file_idx += 1
        if buf:
            out_path = prefix_name + suffix_fn(file_idx, suffix_len)
            data = bytes(buf)
            await write_bytes(accessor, out_path, data)
            writes[out_path] = data
    else:
        line_buf: list[bytes] = []
        async for line in AsyncLineIterator(source):
            line_buf.append(line)
            if len(line_buf) >= lines_per_file:
                out_path = prefix_name + suffix_fn(file_idx, suffix_len)
                data = b"\n".join(line_buf) + b"\n"
                await write_bytes(accessor, out_path, data)
                writes[out_path] = data
                line_buf = []
                file_idx += 1
        if line_buf:
            out_path = prefix_name + suffix_fn(file_idx, suffix_len)
            data = b"\n".join(line_buf) + b"\n"
            await write_bytes(accessor, out_path, data)
            writes[out_path] = data

    return None, IOResult(writes=writes)
