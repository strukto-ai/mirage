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
from mirage.commands.local_audio.utils import (_METADATA_RANGE,
                                               estimate_byte_range, metadata,
                                               transcribe)
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.s3.glob import resolve_glob
from mirage.core.s3.read import read_bytes
from mirage.core.s3.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision import ProvisionResult
from mirage.types import PathSpec


async def head_ogg_provision(
    accessor=None,
    paths: list[PathSpec] | None = None,
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    if not paths or accessor is None:
        return ProvisionResult(command="head")
    s = await stat(accessor, paths[0])
    return ProvisionResult(
        command=f"head {paths[0].original}",
        network_read_low=_METADATA_RANGE,
        network_read_high=s.size,
        read_ops=3,
    )


@command("head",
         resource="s3",
         spec=SPECS["head"],
         filetype=".ogg",
         provision=head_ogg_provision)
async def head_ogg(
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
        raise ValueError("head: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    if c is not None:
        return None, IOResult(
            exit_code=1,
            stderr=b"head: -c not supported for audio files",
        )
    try:
        seconds = int(n) if n is not None else 10
        head_bytes = await read_bytes(accessor,
                                      paths[0],
                                      offset=0,
                                      size=_METADATA_RANGE)
        meta = metadata(head_bytes)
        st = await stat(accessor, paths[0])
        _, end_byte = estimate_byte_range(meta, st.size, end_sec=seconds)
        end_byte = min(int(end_byte * 1.2), st.size)
        raw = await read_bytes(accessor, paths[0], offset=0, size=end_byte)
        stream = transcribe(raw, end_sec=float(seconds))
        return stream, IOResult(reads={paths[0].original: raw},
                                cache=[paths[0].original])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"head: {paths[0].original}: failed to read as ogg: {e}".
            encode(),
        )
