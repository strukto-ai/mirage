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
from mirage.commands.builtin.generic.unzip import unzip_generic
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def unzip(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    resolved = await files.resolve_glob(paths) if paths else []
    # Extraction writes wherever cwd or -d says, which need not be this
    # mount, so the functions are dispatch-relayed and each path routes
    # to the mount that owns it.
    dispatch = dispatch_of(ctx)
    if dispatch is not None:
        prim = transfer_primitives(dispatch)
        return await unzip_generic(
            resolved,
            list(texts),
            ctx,
            prim["read_stream"],
            prim["write"],
            prim["mkdir"],
            stat=prim["stat"],
            relay=True,
        )
    return await unzip_generic(
        resolved,
        list(texts),
        ctx,
        files.read_stream,
        files.write,
        files.mkdir,
        stat=files.stat,
    )


BUILDER = GenericCommand("unzip", unzip, write=True)
