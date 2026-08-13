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

from mirage.accessor.gridfs import GridFSAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.gridfs.io import resolve_glob
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.core.gridfs.mkdir import mkdir as mkdir_impl
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("mkdir", resource="gridfs", spec=SPECS["mkdir"], write=True)
async def mkdir(
    accessor: GridFSAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    index: IndexCacheStore,
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["mkdir"])
    parents = fl.as_bool("parents")
    verbose = fl.as_bool("verbose")
    if not paths:
        raise ValueError("mkdir: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    lines: list[str] = []
    writes: dict[str, ByteSource] = {}
    for path in paths:
        await mkdir_impl(accessor, path, parents=parents)
        writes[path.mount_path] = b""
        if verbose:
            lines.append(f"mkdir: created directory '{path.virtual}'")
    output = ("\n".join(lines) + "\n").encode() if lines else None
    return output, IOResult(writes=writes)
