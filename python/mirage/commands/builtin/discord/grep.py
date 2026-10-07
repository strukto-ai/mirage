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

from mirage.accessor.discord import DiscordAccessor
from mirage.commands.builtin.generic.grep import grep_generic
from mirage.commands.builtin.generic_bind.adapter import (
    Builder,
    CommandIO,
    bound_op,
)
from mirage.commands.builtin.grep_pattern import pattern_arg
from mirage.commands.builtin.grep_pushdown import (
    pushdown_operand,
    text_search_results,
)
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.discord.channels import list_channels
from mirage.core.discord.entry import channel_dirname
from mirage.core.discord.scope import NATIVE_KINDS, detect_scope
from mirage.core.discord.search import format_grep_results, search_guild
from mirage.errors.constants import FS_ERRORS
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.ops.namespace_view import paths_scoped
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.vfs.search import check_search, search_scoped, visible_results

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
SEARCH_HONORED = ("w",)
# rg spells the same flag by its long name.
RG_SEARCH_HONORED = ("word_regexp",)
SEARCH_MAX_RESULTS = 100


async def grep(
    ops: CommandIO,
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)

    pushdown_warnings: list[str] = []
    # Output-shaping flags, a glob operand and a multi-operand line all need
    # the generic scan; see SEARCH_HONORED above.
    scoped = search_scoped(
        opts.ns, [PathSpec.from_str_path(opts.mount_prefix or "/")]
    )
    operand = (
        None
        if scoped
        else pushdown_operand(paths, opts.flags, pattern, SEARCH_HONORED)
    )
    if pattern is not None and operand is not None and fl.as_bool("w"):
        match = detect_scope(operand)
        if not accessor.time_range.bounded and match.kind in NATIVE_KINDS:
            guild_id = match.slots["guild_id"]
            vis = check_search([operand])
            try:
                # Prove the listed name, not just its embedded ID, before
                # using this path to check native results against hides.
                await ops.stat(accessor, operand, index=opts.index)
                msgs = await search_guild(
                    accessor.config,
                    guild_id,
                    pattern,
                    channel_id=match.slots.get("channel_id"),
                    limit=SEARCH_MAX_RESULTS,
                    session=accessor.pool,
                )
                file_prefix = (
                    mount_prefix_of(operand.virtual, operand.vfs_path) or ""
                )
                vfs_first = match.vfs_path.strip("/").split("/", 1)[0]
                channels = await list_channels(
                    accessor.config, guild_id, session=accessor.pool
                )
                channel_map = {c["id"]: channel_dirname(c) for c in channels}
                # Incomplete or unaddressable hits need the guarded walk; a
                # guessed path cannot establish visibility.
                complete = len(msgs) < SEARCH_MAX_RESULTS and all(
                    msg.get("channel_id") in channel_map
                    and msg.get("timestamp")
                    for msg in msgs
                )
                if not paths_scoped(opts.ns, [operand]) or complete:
                    results = format_grep_results(
                        msgs, file_prefix, vfs_first, channel_map
                    )
                    lines = [text for _, text in visible_results(results, vis)]
                    if not lines:
                        return b"", IOResult(exit_code=1)
                    if text_search_results(lines):
                        return format_records(lines), IOResult()
            except FS_ERRORS as exc:
                logger.debug("discord search operand refused: %s", exc)
            except Exception as exc:
                msg = str(exc)
                pushdown_warnings.append(
                    f"discord: native search push-down failed ({msg}); "
                    f"falling back to per-file ops"
                )
                if (
                    "403" in msg
                    or "Forbidden" in msg
                    or "missing access" in msg.lower()
                ):
                    pushdown_warnings.append(
                        "discord: hint - ensure the bot has the "
                        "READ_MESSAGE_HISTORY permission for this guild "
                        "and the MESSAGE CONTENT privileged intent enabled"
                    )
                logger.warning(
                    "discord search push-down failed (%s); "
                    "falling back to per-file ops",
                    exc,
                )

    resolved = (
        await ops.resolve_glob(accessor, paths, index=opts.index)
        if paths
        else []
    )
    out, io = await grep_generic(
        resolved,
        texts,
        opts,
        readdir=bound_op(ops.readdir, accessor, opts.index),
        stat=bound_op(ops.stat, accessor, opts.index),
        read_bytes=bound_op(ops.read_bytes, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )
    if pushdown_warnings:
        extra = ("\n".join(pushdown_warnings) + "\n").encode()
        io.stderr = extra + await materialize(io.stderr)
    return out, io


BUILDER = Builder("grep", grep, read=True)
