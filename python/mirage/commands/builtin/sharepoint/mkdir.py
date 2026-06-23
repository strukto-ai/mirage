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

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.sharepoint.glob import resolve_glob
from mirage.core.sharepoint.mkdir import mkdir as mkdir_impl
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("mkdir", resource="sharepoint", spec=SPECS["mkdir"], write=True)
async def mkdir(
    accessor: SharePointAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    p: bool = False,
    v: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("mkdir: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    lines: list[str] = []
    writes: dict[str, bytes] = {}
    for path in paths:
        await mkdir_impl(accessor, path)
        writes[path.strip_prefix] = b""
        if v:
            lines.append(f"mkdir: created directory '{path.original}'")
    output = ("\n".join(lines) + "\n").encode() if lines else None
    return output, IOResult(writes=writes)
