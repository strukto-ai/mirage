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

from mirage.cache.index import IndexCacheStore
from mirage.commands.local_audio.utils import format_metadata, metadata
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.ram.glob import resolve_glob
from mirage.core.ram.read import read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("stat", resource="ram", spec=SPECS["stat"], filetype=".wav")
async def stat_wav(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if accessor.store is None or not paths:
        raise ValueError("stat: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    try:
        raw = await read_bytes(accessor, paths[0])
        meta = metadata(raw)
        result = format_metadata(meta, paths[0].original, file_size=None)
        return result.encode(), IOResult(reads={paths[0].original: raw},
                                         cache=[paths[0].original])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"stat: {paths[0].original}: failed to read as wav: {e}".
            encode(),
        )
