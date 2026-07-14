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

import json
from collections.abc import AsyncIterator

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.discord._provision import file_read_provision
from mirage.commands.builtin.generic.head import head as generic_head
from mirage.commands.builtin.generic.head import head_multi
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.discord._client import discord_get
from mirage.core.discord.glob import resolve_glob
from mirage.core.discord.history import date_to_snowflake
from mirage.core.discord.read import read as discord_read
from mirage.core.discord.scope import detect_scope
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def head_provision(
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor, paths,
        "head " + " ".join(p.virtual if isinstance(p, PathSpec) else p
                           for p in paths))


@command("head",
         resource="discord",
         spec=SPECS["head"],
         provision=head_provision)
async def head(
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: str | None = None,
    c: str | None = None,
    q: bool = False,
    v: bool = False,
    index: IndexCacheStore,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    n_int = int(n) if n is not None else None
    c_int = int(c) if c is not None else None
    lines = n_int if n_int is not None else 10
    if paths:
        scope = await detect_scope(paths[0], index)

        # Smart head: fetch only first N messages for a single date.
        if (len(paths) == 1 and scope.level == "file" and scope.channel_id
                and scope.date_str and c_int is None):
            after = date_to_snowflake(scope.date_str)
            msgs = await discord_get(
                accessor.config,
                f"/channels/{scope.channel_id}/messages",
                params={
                    "after": after,
                    "limit": lines
                },
            )
            msgs.sort(key=lambda m: int(m["id"]))
            jsonl = "\n".join(
                json.dumps(m, ensure_ascii=False, separators=(",", ":"))
                for m in msgs) + "\n"
            return generic_head(jsonl.encode(), n=lines), IOResult()

        paths = await resolve_glob(accessor, paths, index)
        return head_multi(paths,
                          read=discord_read,
                          accessor=accessor,
                          index=index,
                          n=n_int,
                          c=c_int,
                          show_headers=(v or len(paths) > 1)
                          and not q), IOResult()
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("head: missing operand")
    return generic_head(raw, n=n_int, c=c_int), IOResult()
