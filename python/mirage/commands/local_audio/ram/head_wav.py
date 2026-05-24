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

from mirage.cache.index import IndexCacheStore
from mirage.commands.local_audio.utils import transcribe
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.ram.glob import resolve_glob
from mirage.core.ram.read import read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("head", resource="ram", spec=SPECS["head"], filetype=".wav")
async def head_wav(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: str | None = None,
    c: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.store is None or not paths:
        raise ValueError("head: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    if c is not None:
        return None, IOResult(
            exit_code=1,
            stderr=b"head: -c not supported for audio files",
        )
    try:
        seconds = int(n) if n is not None else 10
        raw = await read_bytes(accessor, paths[0])
        stream = transcribe(raw, end_sec=float(seconds))
        return stream, IOResult(reads={paths[0].original: raw},
                                cache=[paths[0].original])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"head: {paths[0].original}: failed to read as wav: {e}".
            encode(),
        )
