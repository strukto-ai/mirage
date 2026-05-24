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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.filetype.feather import file as feather_file
from mirage.core.gdrive.glob import resolve_glob
from mirage.core.gdrive.read import read as gdrive_read
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("file", resource="gdrive", spec=SPECS["file"], filetype=".arrow")
@command("file", resource="gdrive", spec=SPECS["file"], filetype=".ipc")
@command("file", resource="gdrive", spec=SPECS["file"], filetype=".feather")
async def file_feather(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("file: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    p = paths[0]
    try:
        raw = await gdrive_read(accessor, p, index)
        result = feather_file(raw)
        return result, IOResult(reads={p.strip_prefix: raw},
                                cache=[p.strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"file: {p.original}: failed to read as feather: {e}".
            encode(),
        )
