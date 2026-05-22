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
from mirage.commands.local_audio.utils import (_METADATA_RANGE,
                                               format_metadata, metadata)
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.s3.glob import resolve_glob
from mirage.core.s3.read import read_bytes
from mirage.core.s3.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision import ProvisionResult
from mirage.types import PathSpec


async def stat_mp3_provision(
    accessor=None,
    paths: list[PathSpec] | None = None,
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    if not paths or accessor is None:
        return ProvisionResult(command="stat")
    return ProvisionResult(
        command=f"stat {paths[0].original}",
        network_read_low=_METADATA_RANGE,
        network_read_high=_METADATA_RANGE,
        read_ops=2,
    )


@command("stat",
         resource="s3",
         spec=SPECS["stat"],
         filetype=".mp3",
         provision=stat_mp3_provision)
async def stat_mp3(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("stat: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    try:
        head_bytes = await read_bytes(accessor,
                                      paths[0],
                                      offset=0,
                                      size=_METADATA_RANGE)
        meta = metadata(head_bytes)
        fs = await stat(accessor, paths[0])
        result = format_metadata(meta, paths[0].original, file_size=fs.size)
        return result.encode(), IOResult(cache=[paths[0].original])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"stat: {paths[0].original}: failed to read as mp3: {e}".
            encode(),
        )
