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
from mirage.commands.builtin.generic.crossmount.utils import (
    transfer_primitives,
)
from mirage.commands.builtin.generic.tar import tar_generic
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.archive_io import (
    is_dir_of,
    relay_is_dir_of,
    walk_of,
)
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def tar(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    resolved = await files.resolve_glob(paths)
    fl = FlagView(ctx.flags, spec=SPECS["tar"])
    dispatch = dispatch_of(ctx)
    if dispatch is not None and not fl.as_bool("create"):
        # -t reads and -x writes wherever cwd or -C says, which needs
        # not be this mount, so both run on dispatch-relayed calls and
        # each path routes to the mount that owns it. Only -c stays on
        # this mount's own walk: its planner walks this mount's tree.
        prim = transfer_primitives(dispatch)
        return await tar_generic(
            resolved,
            list(texts),
            ctx,
            prim["read_stream"],
            prim["write"],
            prim["mkdir"],
            prim["stat"],
            walk_of(files, dispatch, "tar"),
            relay_is_dir_of(dispatch),
            relay=True,
        )
    return await tar_generic(
        resolved,
        list(texts),
        ctx,
        files.read_stream,
        # Archive output follows links even when the member scan
        # preserves them.
        transfer_primitives(dispatch)["write"]
        if dispatch is not None
        else files.write,
        files.mkdir,
        files.stat,
        walk_of(files, dispatch, "tar"),
        is_dir_of(files),
    )


BUILDER = GenericCommand("tar", tar, write=True)
