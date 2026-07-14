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

import logging
from collections.abc import AsyncIterator

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.discord._provision import file_read_provision
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.grep_helper import pattern_arg
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.discord.channels import list_channels
from mirage.core.discord.entry import channel_dirname
from mirage.core.discord.formatters import format_grep_results
from mirage.core.discord.glob import resolve_glob
from mirage.core.discord.read import read as discord_read
from mirage.core.discord.readdir import readdir as _readdir
from mirage.core.discord.scope import coalesce_scopes, detect_scope
from mirage.core.discord.search import search_guild
from mirage.core.discord.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


async def grep_provision(
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor, paths,
        "grep " + " ".join(texts + tuple(str(p) for p in paths)))


@command("grep",
         resource="discord",
         spec=SPECS["grep"],
         provision=grep_provision)
async def grep(
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    prefix: str = "",
    index: IndexCacheStore,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)
    max_count = fl.int("m")

    pushdown_warnings: list[str] = []
    if paths and pattern is not None and "\n" not in pattern:
        scope = await detect_scope(paths[0], index)
        if scope.level in ("messages", "file_blob", "date"):
            coalesced = await coalesce_scopes(paths, index)
            if coalesced is not None:
                scope = coalesced

        if scope.level == "root":
            return b"", IOResult(exit_code=1,
                                 stderr=b"grep: root-level search "
                                 b"not yet supported\n")

        if scope.level in ("channel", "guild"):
            try:
                if scope.guild_id is None:
                    raise RuntimeError("cannot resolve guild ID")
                msgs = await search_guild(
                    accessor.config,
                    scope.guild_id,
                    pattern,
                    channel_id=scope.channel_id,
                    limit=max_count or 100,
                )
                file_prefix = mount_prefix_of(paths[0].virtual,
                                              paths[0].resource_path) or ""
                resource_first = scope.resource_path.split("/", 1)[0]
                channels = await list_channels(accessor.config, scope.guild_id)
                channel_map = {c["id"]: channel_dirname(c) for c in channels}
                lines = format_grep_results(msgs, file_prefix, resource_first,
                                            channel_map)
                if not lines:
                    return b"", IOResult(exit_code=1)
                return format_records(lines), IOResult()
            except Exception as exc:
                msg = str(exc)
                pushdown_warnings.append(
                    f"discord: native search push-down failed ({msg}); "
                    f"falling back to per-file scan")
                if ("403" in msg or "Forbidden" in msg
                        or "missing access" in msg.lower()):
                    pushdown_warnings.append(
                        "discord: hint - ensure the bot has the "
                        "READ_MESSAGE_HISTORY permission for this guild "
                        "and the MESSAGE CONTENT privileged intent enabled")
                logger.warning(
                    "discord search push-down failed (%s); "
                    "falling back to per-file scan", exc)

    resolved = await resolve_glob(accessor, paths,
                                  index=index) if paths else []
    out, io = await generic_grep(
        resolved,
        texts,
        flags,
        readdir=_readdir,
        stat=_stat,
        read_bytes=discord_read,
        read_stream=None,
        accessor=accessor,
        stdin=stdin,
        index=index,
    )
    if pushdown_warnings:
        extra = ("\n".join(pushdown_warnings) + "\n").encode()
        io.stderr = extra + (io.stderr or b"")
    return out, io
