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

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation)
from mirage.commands.builtin.utils.output import format_optional_records
from mirage.commands.errors import UsageError
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def rmdir(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    v: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor) or not paths:
        raise UsageError(
            "rmdir: missing operand\n"
            "Try 'rmdir --help' for more information.", 1)
    rmdir_fn = ops.require(Operation.RMDIR)
    paths = await ops.resolve_glob(accessor, paths, index)
    verbose_parts: list[str] = []
    errors: list[str] = []
    removed: dict[str, ByteSource] = {}
    for p in paths:
        try:
            s = await ops.stat(accessor, p)
        except FileNotFoundError:
            errors.append(f"rmdir: failed to remove '{p.virtual}': "
                          "No such file or directory")
            continue
        if s.type != FileType.DIRECTORY:
            errors.append(
                f"rmdir: failed to remove '{p.virtual}': Not a directory")
            continue
        if await ops.readdir(accessor, p, index=index):
            errors.append(f"rmdir: failed to remove '{p.virtual}': "
                          "Directory not empty")
            continue
        await rmdir_fn(accessor, p)
        removed[p.mount_path] = b""
        if v:
            verbose_parts.append(f"rmdir: removing directory, '{p.virtual}'")
    output = format_optional_records(verbose_parts) if v else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return output, IOResult(writes=removed,
                            stderr=stderr,
                            exit_code=1 if errors else 0)


BUILDER = Builder('rmdir',
                  rmdir,
                  write=True,
                  requirements=frozenset({Operation.RMDIR}))
