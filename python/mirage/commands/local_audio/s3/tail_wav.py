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
from mirage.commands.local_audio.utils import metadata, transcribe
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.s3.glob import resolve_glob
from mirage.core.s3.read import read_bytes
from mirage.core.s3.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision import ProvisionResult
from mirage.types import PathSpec


async def tail_wav_provision(
    accessor=None,
    paths: list[PathSpec] | None = None,
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    if not paths or accessor is None:
        return ProvisionResult(command="tail")
    s = await stat(accessor, paths[0])
    return ProvisionResult(
        command=f"tail {paths[0].original}",
        network_read_low=s.size,
        network_read_high=s.size,
        read_ops=1,
    )


@command("tail",
         resource="s3",
         spec=SPECS["tail"],
         filetype=".wav",
         provision=tail_wav_provision)
async def tail_wav(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: str | None = None,
    c: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("tail: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    if c is not None:
        return None, IOResult(
            exit_code=1,
            stderr=b"tail: -c not supported for audio files",
        )
    try:
        seconds = int(n) if n is not None else 10
        raw = await read_bytes(accessor, paths[0])
        meta = metadata(raw)
        duration = meta.get("duration", 0) or 0
        start = max(0.0, duration - seconds)
        stream = transcribe(raw, start_sec=start)
        return stream, IOResult(reads={paths[0].original: raw},
                                cache=[paths[0].original])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"tail: {paths[0].original}: failed to read as wav: {e}".
            encode(),
        )
