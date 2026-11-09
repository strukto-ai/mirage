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
from mirage.commands.config import Context, command
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.usage import (
    extra_operand_error,
    missing_operand_error,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


def _refused(source: PathSpec, target: PathSpec, why: str) -> IOResult:
    line = (
        f"link: cannot create link '{quote_text(target.raw_path)}' "
        f"to '{quote_text(source.raw_path)}': {why}\n"
    )
    return IOResult(exit_code=1, stderr=line.encode())


@command("link", vfs=None, spec=SPECS["link"])
async def link(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """A hard link is a byte copy here, as ``ln``'s is, through the
    session's files. Pinned against coreutils 9.7.
    """
    if not paths:
        raise missing_operand_error("link", None)
    if len(paths) == 1:
        raise missing_operand_error("link", paths[0].raw_path)
    if len(paths) > 2:
        raise extra_operand_error("link", paths[2].raw_path)
    source, target = paths
    if ctx.vfs is None:
        return None, IOResult(exit_code=1)
    try:
        row = await ctx.vfs.stat(source)
    except FS_ERRORS as exc:
        return None, _refused(source, target, fs_strerror(exc) or str(exc))
    if await ctx.vfs.exists(target):
        return None, _refused(source, target, "File exists")
    if row.type == FileType.DIRECTORY:
        return None, _refused(source, target, "Operation not permitted")
    try:
        await ctx.vfs.write(target, await ctx.vfs.read(source))
    except FS_ERRORS as exc:
        return None, _refused(source, target, fs_strerror(exc) or str(exc))
    return None, IOResult()
