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
from mirage.commands.builtin.generic.tee import tee_generic as generic_tee
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.utils.links import links_of, mount_root
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def tee(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    paths = await files.resolve_glob(paths) if paths else []
    links = links_of(ctx)
    return await generic_tee(
        paths,
        texts,
        read_stream=files.read,
        write_bytes=files.write,
        # A backend that can append natively does; the rest fall back to
        # the read-modify-write inside the generic.
        append_bytes=(files.append if files.answers("append") else None),
        stdin=ctx.stdin,
        flags=ctx.flags,
        stat=files.stat,
        output_key=(lambda p: links.resolve(p.virtual))
        if links is not None
        else None,
        root=mount_root(ctx),
    )


BUILDER = GenericCommand("tee", tee, write=True)
