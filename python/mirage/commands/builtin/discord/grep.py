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
from dataclasses import replace

from mirage.accessor.discord import DiscordAccessor
from mirage.commands.builtin.discord._provision import file_read_provision
from mirage.commands.builtin.discord.io import resolve_glob
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.grep_pattern import pattern_arg
from mirage.commands.builtin.grep_pushdown import pushdown_operand
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.discord.channels import list_channels
from mirage.core.discord.entry import channel_dirname
from mirage.core.discord.formatters import format_grep_results
from mirage.core.discord.read import read as discord_read
from mirage.core.discord.readdir import readdir as _readdir
from mirage.core.discord.scope import NATIVE_KINDS, detect_scope
from mirage.core.discord.search import search_guild
from mirage.core.discord.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)

# Discord guild search answers with whole messages and the push-down prints
# that answer verbatim, so it can stand in for a scan only when the line names
# one concrete operand and no flag reshapes the output. -w is the exception
# the provider itself supplies: the search matches whole words, so a bare
# literal would under-report and only -w makes the two agree.
#
# `coalesce_scopes` used to widen a set of same-channel chat.jsonl operands
# into one channel-wide search, and it is deliberately not consulted here.
# `search_guild` takes a channel but no date, so folding two named days
# returned every day the channel ever had — and a single chat.jsonl operand
# was widened the same way. Reporting messages the line did not ask for is not
# a better failure than dropping an operand. One operand or the generic scan.
SEARCH_HONORED = ("w", )
SEARCH_MAX_RESULTS = 100


async def grep_provision(accessor: DiscordAccessor, paths: list[PathSpec],
                         texts: list[str],
                         opts: CommandOpts) -> ProvisionResult:
    line = "grep " + " ".join(list(texts) + [str(p) for p in paths])
    return await file_read_provision(accessor, paths, texts,
                                     replace(opts, command=line))


@command("grep",
         resource="discord",
         spec=SPECS["grep"],
         provision=grep_provision)
async def grep(accessor: DiscordAccessor, paths: list[PathSpec],
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)

    pushdown_warnings: list[str] = []
    # Output-shaping flags, a glob operand and a multi-operand line all need
    # the generic scan; see SEARCH_HONORED above.
    operand = pushdown_operand(paths, opts.flags, pattern, SEARCH_HONORED)
    if pattern is not None and operand is not None and fl.as_bool("w"):
        match = detect_scope(operand)
        if match.kind in NATIVE_KINDS:
            guild_id = match.slots["guild_id"]
            try:
                msgs = await search_guild(
                    accessor.config,
                    guild_id,
                    pattern,
                    channel_id=match.slots.get("channel_id"),
                    limit=SEARCH_MAX_RESULTS,
                    session=accessor.pool)
                file_prefix = mount_prefix_of(operand.virtual,
                                              operand.resource_path) or ""
                resource_first = match.resource_path.strip("/").split("/",
                                                                      1)[0]
                channels = await list_channels(accessor.config,
                                               guild_id,
                                               session=accessor.pool)
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
                                  index=opts.index) if paths else []
    out, io = await generic_grep(
        resolved,
        texts,
        opts,
        readdir=bound_op(_readdir, accessor, opts.index),
        stat=bound_op(_stat, accessor, opts.index),
        read_bytes=bound_op(discord_read, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )
    if pushdown_warnings:
        extra = ("\n".join(pushdown_warnings) + "\n").encode()
        io.stderr = extra + await materialize(io.stderr)
    return out, io
