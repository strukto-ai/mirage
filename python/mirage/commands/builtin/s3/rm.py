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

from mirage.accessor.s3 import S3Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic_bind.provision import \
    write_metadata_provision
from mirage.commands.builtin.s3.ops import RESOLVE_GLOB as resolve_glob
from mirage.commands.builtin.utils.output import format_optional_records
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.s3.readdir import readdir
from mirage.core.s3.rm import rm_r
from mirage.core.s3.rmdir import rmdir
from mirage.core.s3.stat import stat
from mirage.core.s3.unlink import unlink
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def _rm(
    accessor: S3Accessor,
    path: PathSpec,
    recursive: bool = False,
    force: bool = False,
    remove_dir: bool = False,
    *,
    index: IndexCacheStore,
) -> None:
    try:
        s = await stat(accessor, path, index=index)
    except (FileNotFoundError, ValueError):
        if force:
            return
        raise
    label = path.virtual
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


@command("rm",
         resource="s3",
         spec=SPECS["rm"],
         write=True,
         provision=write_metadata_provision)
async def rm(
    accessor: S3Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    r: bool = False,
    R: bool = False,
    f: bool = False,
    v: bool = False,
    d: bool = False,
    index: IndexCacheStore,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("rm: missing operand")
    paths = await resolve_glob(accessor, paths, index)
    verbose_parts: list[str] = []
    removed: dict[str, ByteSource] = {}
    for p in paths:
        await _rm(accessor,
                  p,
                  recursive=r or R,
                  force=f,
                  remove_dir=d,
                  index=index)
        removed[p.mount_path] = b""
        if v:
            verbose_parts.append(f"removed '{p.virtual}'")
    output = format_optional_records(verbose_parts) if v else None
    return output, IOResult(writes=removed)
