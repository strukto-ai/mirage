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

from mirage.accessor.slack import SlackAccessor
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.render.json import compact_json_bytes
from mirage.core.slack.post import upload_file as share_file
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def upload_file(
    accessor: SlackAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    source = fl.as_path("file")
    if source is None:
        raise ValueError("--file expects a file")
    if ctx.vfs is None:
        raise ValueError("--file needs a workspace to read files from")
    try:
        data = await ctx.vfs.read(source)
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise ValueError(
            f"read {source.virtual}: {fs_strerror(exc)}"
        ) from None
    result = await share_file(
        accessor,
        fl.as_str("channel") or "",
        posixpath.basename(source.virtual.rstrip("/")),
        data,
        fl.as_str("initial_comment"),
        fl.as_str("thread_ts"),
    )
    return compact_json_bytes(result), IOResult()
