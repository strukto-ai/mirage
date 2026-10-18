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
from mirage.commands.builtin.generic.zgrep import zgrep_generic
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.utils.links import link_resolver
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import utf8_locale
from mirage.types import PathSpec


async def zgrep(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    resolved = await files.resolve_glob(paths) if paths else []
    return await zgrep_generic(
        resolved,
        texts,
        ctx.flags,
        read_bytes=files.read_stream,
        stdin=ctx.stdin,
        stat=files.stat,
        resolver=link_resolver(ctx),
        utf8=utf8_locale(ctx.env),
    )


BUILDER = GenericCommand("zgrep", zgrep, read=True)
