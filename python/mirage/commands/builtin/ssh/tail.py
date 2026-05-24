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

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.tail_helper import _parse_n, tail_bytes
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.ssh.glob import resolve_glob
from mirage.core.ssh.read import read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tail", resource="ssh", spec=SPECS["tail"])
async def tail(
    accessor: SSHAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: str | None = None,
    c: str | None = None,
    q: bool = False,
    v: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    lines, plus_mode = _parse_n(n)
    bytes_mode = int(c) if c is not None else None
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        raw = await read_bytes(accessor, paths[0])
        if bytes_mode is not None:
            result = raw[-bytes_mode:] if bytes_mode else b""
            should_cache = bytes_mode >= len(raw)
        else:
            result = tail_bytes(raw, lines, plus_mode=plus_mode)
            should_cache = not plus_mode and lines >= raw.count(b"\n")
        cache = [paths[0].original] if should_cache else []
        return result, IOResult(cache=cache)
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("tail: missing operand")
    if bytes_mode is not None:
        return raw[-bytes_mode:], IOResult()
    return tail_bytes(raw, lines, plus_mode=plus_mode), IOResult()
