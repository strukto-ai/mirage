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
from mirage.commands.builtin.generic.mktemp import mktemp_generic
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.utils.paths import vfs_stat_path
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def mktemp(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    # The name a pathless mktemp creates is under $TMPDIR or /tmp, which
    # the working directory's mount rarely owns, so the create goes
    # through the dispatcher to whichever mount does.
    vfs = ctx.vfs
    if vfs is None:
        raise TypeError("mktemp: no workspace files")
    dispatch = vfs.dispatch
    stat_path = vfs_stat_path(vfs)

    async def mkdir(path: PathSpec) -> None:
        await dispatch("mkdir", path)

    async def write(path: PathSpec, data: bytes) -> None:
        await dispatch("write", path, data=data)

    async def exists(path: PathSpec) -> bool:
        return stat_path is not None and await stat_path(path) is not None

    return await mktemp_generic(paths, list(texts), ctx, mkdir, write, exists)


BUILDER = GenericCommand("mktemp", mktemp, write=True)
