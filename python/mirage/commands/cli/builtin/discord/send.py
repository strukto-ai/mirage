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

import posixpath

from mirage.accessor.discord import DiscordAccessor
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.discord.post import send_message
from mirage.core.render.json import compact_json_bytes
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.workspace.files import Files


async def _attachment(
    vfs: Files | None, source: PathSpec | None
) -> tuple[str, bytes] | None:
    if source is None:
        return None
    if vfs is None:
        raise ValueError("--file needs a workspace to read files from")
    try:
        data = await vfs.read(source)
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise ValueError(
            f"read {source.virtual}: {fs_strerror(exc)}"
        ) from None
    return posixpath.basename(source.virtual.rstrip("/")), data


async def send(
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    result = await send_message(
        accessor,
        fl.as_str("channel") or "",
        fl.as_str("text") or "",
        fl.as_str("reply_to"),
        await _attachment(ctx.vfs, fl.as_path("file")),
    )
    out = compact_json_bytes(result)
    return out, IOResult()
