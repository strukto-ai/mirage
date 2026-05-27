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

import re
from collections.abc import AsyncIterator

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.hf_buckets.glob import resolve_glob
from mirage.core.hf_buckets.read import read_bytes
from mirage.core.hf_buckets.write import write_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _split_by_patterns(
    lines: list[str],
    patterns: list[str],
) -> list[list[str]]:
    parts: list[list[str]] = []
    current_start = 0
    for pat in patterns:
        if pat.startswith("/") and pat.endswith("/"):
            regex = pat[1:-1]
            for idx in range(current_start, len(lines)):
                if re.search(regex, lines[idx]):
                    parts.append(lines[current_start:idx])
                    current_start = idx
                    break
        else:
            line_num = int(pat)
            split_at = line_num - 1
            if split_at > current_start:
                parts.append(lines[current_start:split_at])
                current_start = split_at
    if current_start < len(lines):
        parts.append(lines[current_start:])
    return parts


@command("csplit", resource="hf_buckets", spec=SPECS["csplit"], write=True)
async def csplit(
    accessor: HfBucketsAccessor,
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
    prefix = f or "xx"
    digits = int(n) if n else 2
    suffix_fmt = b if b else f"%0{digits}d"
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        raw = await read_bytes(accessor, paths[0])
    else:
        raw = await _read_stdin_async(stdin)
        if raw is None:
            raise ValueError("csplit: missing input")
    text = raw.decode(errors="replace")
    lines = text.splitlines()
    patterns = list(texts)
    parts = _split_by_patterns(lines, patterns)
    writes: dict[str, bytes] = {}
    sizes: list[str] = []
    try:
        for idx, part in enumerate(parts):
            filename = prefix + (suffix_fmt % idx)
            data = ("\n".join(part) + "\n").encode() if part else b""
            await write_bytes(accessor, filename, data)
            writes[filename] = data
            sizes.append(str(len(data)))
    except Exception:
        if not k:
            raise
    output = "" if s else "\n".join(sizes) + "\n"
    return output.encode(), IOResult(writes=writes)
