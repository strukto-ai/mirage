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

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.filetype.feather import file as feather_file
from mirage.core.ssh.glob import resolve_glob
from mirage.core.ssh.read import read_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("file", resource="ssh", spec=SPECS["file"], filetype=".arrow")
@command("file", resource="ssh", spec=SPECS["file"], filetype=".ipc")
@command("file", resource="ssh", spec=SPECS["file"], filetype=".feather")
async def file_feather(
    accessor: SSHAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("file: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    try:
        raw = await read_bytes(accessor, paths[0])
        result = feather_file(raw)
        return result, IOResult(reads={paths[0].strip_prefix: raw},
                                cache=[paths[0].strip_prefix])
    except Exception as e:
        return None, IOResult(
            exit_code=1,
            stderr=f"file: {paths[0].original}: failed to read as feather: {e}"
            .encode(),
        )
