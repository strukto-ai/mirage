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
from mirage.core.sharepoint.readdir import readdir
from mirage.core.sharepoint.rm import rm_r
from mirage.core.sharepoint.rmdir import rmdir
from mirage.core.sharepoint.stat import stat
from mirage.core.sharepoint.unlink import unlink
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def _rm(
    accessor: SharePointAccessor,
    path: PathSpec | str,
    recursive: bool = False,
    force: bool = False,
    remove_dir: bool = False,
    index: IndexCacheStore = None,
) -> None:
    try:
        s = await stat(accessor, path)
    except (FileNotFoundError, ValueError):
        if force:
            return
        raise
    label = path.original if isinstance(path, PathSpec) else path
    if s.type == FileType.DIRECTORY:
        if recursive:
            await rm_r(accessor, path)
        elif remove_dir:
            children = await readdir(accessor, path, index)
            if children:
                raise OSError(f"directory not empty: {label}")
            await rmdir(accessor, path)
        else:
            raise IsADirectoryError(
                f"{label}: is a directory (use recursive=True)")
    else:
        await unlink(accessor, path)


@command("rm", resource="sharepoint", spec=SPECS["rm"], write=True)
async def rm(
    accessor: SharePointAccessor,
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
    paths = await resolve_glob(accessor, paths, index)
    verbose_parts: list[str] = []
    removed: dict[str, bytes] = {}
    for p in paths:
        await _rm(accessor,
                  p,
                  recursive=r or R,
                  force=f,
                  remove_dir=d,
                  index=index)
        removed[p.strip_prefix] = b""
        if v:
            verbose_parts.append(f"removed '{p.original}'")
    output = "\n".join(verbose_parts).encode() if v else None
    return output, IOResult(writes=removed)
