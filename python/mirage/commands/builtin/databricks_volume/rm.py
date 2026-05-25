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

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.databricks_volume.glob import resolve_glob
from mirage.core.databricks_volume.unlink import unlink
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("rm", resource="databricks_volume", spec=SPECS["rm"], write=True)
async def rm(
    accessor: DatabricksVolumeAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    r: bool = False,
    R: bool = False,
    f: bool = False,
    v: bool = False,
    d: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("rm: missing operand")
    if r or R or d:
        raise ValueError(
            "rm: recursive and directory removal are not supported")
    paths = await resolve_glob(accessor, paths, index)
    verbose_parts: list[str] = []
    removed: dict[str, bytes] = {}
    for path in paths:
        try:
            await unlink(accessor, path, index)
        except IsADirectoryError as exc:
            raise IsADirectoryError(
                f"rm: cannot remove '{path.original}': Is a directory"
            ) from exc
        except FileNotFoundError:
            if f:
                continue
            raise
        removed[path.strip_prefix] = b""
        if v:
            verbose_parts.append(f"removed '{path.original}'")
    output = "\n".join(verbose_parts).encode() if v else None
    return output, IOResult(writes=removed)
