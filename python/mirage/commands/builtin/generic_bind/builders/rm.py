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

from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.utils.output import format_optional_records
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def rm(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    r: bool = False,
    R: bool = False,
    f: bool = False,
    v: bool = False,
    d: bool = False,
    index: object = None,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor) or not paths:
        raise ValueError("rm: missing operand")
    paths = await ops.resolve_glob(accessor, paths, index)
    recursive = r or R
    verbose_parts: list[str] = []
    removed: dict[str, bytes] = {}
    for p in paths:
        try:
            s = await ops.stat(accessor, p)
        except FileNotFoundError:
            if f:
                continue
            raise
        if s.type == FileType.DIRECTORY:
            if recursive:
                await ops.rm_r(accessor, p)
            elif d:
                await ops.rmdir(accessor, p)
            else:
                raise IsADirectoryError(
                    f"rm: cannot remove '{p.original}': Is a directory")
        else:
            await ops.unlink(accessor, p)
        removed[p.strip_prefix] = b""
        if v:
            verbose_parts.append(f"removed '{p.original}'")
    output = format_optional_records(verbose_parts) if v else None
    return output, IOResult(writes=removed)


# (name, builder, provision_builder, write, aggregate)
BUILDER = ('rm', rm, None, True, None)
