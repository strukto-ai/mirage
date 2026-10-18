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
from mirage.commands.builtin.generic.crossmount.utils import transfer_links_of
from mirage.commands.builtin.generic.mv import mv_generic as generic_mv
from mirage.commands.builtin.generic.mv import parse_flags
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    command_files,
    refuse_reveal,
)
from mirage.commands.builtin.utils.links import (
    links_of,
    mounts_of,
    visibility_of,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import NativeMove, PathSpec


async def mv(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    fl = FlagView(ctx.flags, spec=SPECS["mv"])
    parsed = parse_flags(fl)
    paths = await files.resolve_glob(paths)
    links = links_of(ctx)
    mounts = mounts_of(ctx)

    def guard(src: PathSpec, dst: PathSpec) -> None:
        refuse_reveal(
            src, dst, ctx.session.access() if ctx.session is not None else None
        )

    return await generic_mv(
        paths,
        strategy=NativeMove(rename=files.rename),
        stat=files.stat,
        flags=parsed,
        readdir=files.readdir,
        guard=guard,
        copies=(
            transfer_links_of(
                links,
                ctx.vfs.dispatch,
                ctx.cwd.virtual,
                visibility_of(ctx.vfs),
            )
            if links is not None and ctx.vfs is not None
            else None
        ),
        stdin=ctx.stdin,
        mount_root=mounts.is_root if mounts is not None else None,
    )


BUILDER = GenericCommand("mv", mv, write=True)
