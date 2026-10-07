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
from mirage.commands.builtin.discord.grep import (
    RG_SEARCH_HONORED,
    SEARCH_MAX_RESULTS,
)
from mirage.commands.builtin.generic.rg import (
    parse_flags,
    refuse_missing_pattern,
    rg_generic,
)
from mirage.commands.builtin.generic_bind.adapter import (
    Builder,
    CommandIO,
    bound_op,
)
from mirage.commands.builtin.grep_pattern import pattern_arg
from mirage.commands.builtin.grep_pushdown import pushdown_operand
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.discord.channels import list_channels
from mirage.core.discord.entry import channel_dirname
from mirage.core.discord.scope import NATIVE_KINDS, detect_scope
from mirage.core.discord.search import format_grep_results, search_guild
from mirage.errors.constants import FS_ERRORS
from mirage.io.types import ByteSource, IOResult
from mirage.ops.namespace_view import paths_scoped
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.vfs.search import check_search, search_scoped, visible_results

logger = logging.getLogger(__name__)


async def rg(
    ops: CommandIO,
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl, "regexp")
    refuse_missing_pattern(pattern_str, fl, parse_flags(fl))

    pushdown_warnings: list[str] = []
    # Output-shaping flags, a glob operand and a multi-operand line all need
    # the generic scan; see SEARCH_HONORED above.
    scoped = search_scoped(
        opts.ns, [PathSpec.from_str_path(opts.mount_prefix or "/")]
    )
    operand = (
        None
        if scoped
        else pushdown_operand(
            paths, opts.flags, pattern_str, RG_SEARCH_HONORED
        )
    )
    if (
        operand is not None
        and pattern_str is not None
        and fl.as_bool("word_regexp")
    ):
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
                    pattern_str,
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
    stdout, io = await rg_generic(
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
        io.stderr = ("\n".join(pushdown_warnings) + "\n").encode()
    return stdout, io


BUILDER = Builder("rg", rg, read=True)
