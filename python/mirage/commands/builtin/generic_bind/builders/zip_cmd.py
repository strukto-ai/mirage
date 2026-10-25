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
from mirage.commands.builtin.generic.zip_cmd import parse_flags, zip_cmd
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.archive_io import walk_of
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.utils.links import (
    dispatch_of,
    links_of,
    mount_view,
)
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def zip_builder(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    if not paths:
        raise ValueError("zip: usage: zip archive.zip file1 [file2 ...]")
    return await zip_cmd(
        await files.resolve_glob(paths),
        stream=normalized_read(files.read),
        dispatch=dispatch_of(ctx),
        cwd=ctx.cwd,
        stat=files.stat,
        walk=walk_of(files, dispatch_of(ctx), "zip"),
        flags=parse_flags(ctx.flags),
        links=links_of(ctx),
        mounts=mount_view(ctx.vfs),
    )


BUILDER = GenericCommand("zip", zip_builder, write=True)
