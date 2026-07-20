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

import functools

from mirage.accessor.gridfs import GridFSAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.cp import walk
from mirage.commands.builtin.generic_bind.provision import \
    write_metadata_provision
from mirage.commands.builtin.gridfs.io import resolve_glob
from mirage.commands.builtin.utils.output import format_optional_records
from mirage.commands.builtin.utils.verbose import removal_lines
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gridfs.readdir import readdir
from mirage.core.gridfs.rm import rm_r
from mirage.core.gridfs.rmdir import rmdir
from mirage.core.gridfs.stat import stat
from mirage.core.gridfs.unlink import unlink
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def _rm(
    accessor: GridFSAccessor,
    path: PathSpec,
    recursive: bool = False,
    force: bool = False,
    remove_dir: bool = False,
    verbose: bool = False,
    *,
    index: IndexCacheStore,
) -> tuple[str | None, list[str]]:
    """Remove one operand, returning a GNU stderr line on failure.

    Args:
        accessor (GridFSAccessor): Backend handle.
        path (PathSpec): The operand to remove.
        recursive (bool): ``-r``; remove directories and their contents.
        force (bool): ``-f``; a missing operand is not an error.
        remove_dir (bool): ``-d``; remove empty directories.
        verbose (bool): ``-v``; collect one ``removed ...`` line per entry.
        index (IndexCacheStore): Cache index threaded into the core ops.

    Returns:
        tuple[str | None, list[str]]: A ``rm: cannot remove ...`` line (or
        None when removed / skipped under ``-f``) and the verbose lines.
    """
    label = path.virtual
    try:
        s = await stat(accessor, path, index=index)
    except (FileNotFoundError, ValueError):
        if force:
            return None, []
        return f"rm: cannot remove '{label}': No such file or directory", []
    if s.type == FileType.DIRECTORY:
        if recursive:
            lines = removal_lines(await walk(
                functools.partial(readdir, accessor, index=index),
                functools.partial(stat, accessor, index=index),
                path)) if verbose else []
            await rm_r(accessor, path)
            return None, lines
        if remove_dir:
            children = await readdir(accessor, path, index)
            if children:
                return (f"rm: cannot remove '{label}': Directory not empty",
                        [])
            await rmdir(accessor, path)
            return None, [f"removed directory '{label}'"] if verbose else []
        return f"rm: cannot remove '{label}': Is a directory", []
    await unlink(accessor, path)
    return None, [f"removed '{label}'"] if verbose else []


@command("rm",
         resource="gridfs",
         spec=SPECS["rm"],
         write=True,
         provision=write_metadata_provision)
async def rm(
    accessor: GridFSAccessor,
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
    errors: list[str] = []
    removed: dict[str, ByteSource] = {}
    for p in paths:
        error, entry_lines = await _rm(accessor,
                                       p,
                                       recursive=r or R,
                                       force=f,
                                       remove_dir=d,
                                       verbose=v,
                                       index=index)
        if error is not None:
            errors.append(error)
            continue
        removed[p.mount_path] = b""
        verbose_parts.extend(entry_lines)
    output = format_optional_records(verbose_parts) if v else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return output, IOResult(writes=removed,
                            stderr=stderr,
                            exit_code=1 if errors else 0)
