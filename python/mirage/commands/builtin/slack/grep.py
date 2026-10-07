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

from mirage.accessor.slack import SlackAccessor
from mirage.commands.builtin.generic.grep import grep_generic
from mirage.commands.builtin.generic_bind.adapter import (
    bound_op,
    scan_io,
)
from mirage.commands.builtin.grep_pattern import pattern_arg
from mirage.commands.builtin.grep_pushdown import (
    pushdown_operand,
    text_search_results,
)
from mirage.commands.builtin.slack.io import IO
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.slack.formatters import (
    build_query,
    format_file_grep_results,
    format_grep_results,
)
from mirage.core.slack.scope import NATIVE_KINDS, detect_scope, search_target
from mirage.core.slack.search import (
    search_available,
    search_files,
    search_messages,
)
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)

# Slack search answers with whole messages and the push-down prints that
# answer verbatim, so it can stand in for a scan only when the line names one
# concrete operand and no flag reshapes the output. -w is the exception the
# provider itself supplies: Slack matches whole words, so a bare literal would
# under-report and only -w makes the two agree.
#
# `coalesce_scopes` used to widen a set of same-channel operands into one
# channel-wide search, and it is deliberately not consulted here. It cannot
# answer a line whose operands name two different channels (it returns None
# and the first operand won anyway), and where it did fold it dropped the
# date: `build_query` carries only `in:#channel`, so two named days became
# every day the channel ever had. Reporting messages the line did not ask for
# is not a better failure than dropping an operand. One operand or the
# generic scan.
SEARCH_HONORED = ("w",)
# rg spells the same flag by its long name.
RG_SEARCH_HONORED = ("word_regexp",)
SEARCH_MAX_RESULTS = 100


@command("grep", vfs="slack", spec=SPECS["grep"])
async def grep(
    accessor: SlackAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)

    # Output-shaping flags, a glob operand and a multi-operand line all need
    # the per-message scan; see SEARCH_HONORED above.
    scan, scoped = scan_io(IO, opts.ns, opts.mount_prefix)
    operand = (
        None
        if scoped
        else pushdown_operand(paths, opts.flags, pattern, SEARCH_HONORED)
    )
    if pattern is not None and operand is not None and fl.as_bool("w"):
        match = detect_scope(operand)
        if (
            not accessor.time_range.bounded
            and match.kind in NATIVE_KINDS
            and search_available(accessor.config)
        ):
            target = search_target(match)
            file_prefix = (
                mount_prefix_of(operand.virtual, operand.vfs_path) or ""
            )
            query = build_query(pattern, target)
            # Every kind that reaches here searches messages, and each of
            # them (the root, the containers, a channel, a date dir)
            # carries files too, so both halves run.
            native_lines: list[str] = []
            err: Exception | None = None
            try:
                raw = await search_messages(
                    accessor.config,
                    query,
                    count=SEARCH_MAX_RESULTS,
                    session=accessor.pool,
                )
                native_lines.extend(
                    format_grep_results(raw, target, file_prefix)
                )
                raw_f = await search_files(
                    accessor.config,
                    query,
                    count=SEARCH_MAX_RESULTS,
                    session=accessor.pool,
                )
                native_lines.extend(
                    format_file_grep_results(raw_f, target, file_prefix)
                )
            except Exception as exc:
                err = exc
            if err is None:
                if not native_lines:
                    return b"", IOResult(exit_code=1)
                if text_search_results(native_lines):
                    return format_records(native_lines), IOResult()
            if err is not None:
                logger.warning(
                    "slack search push-down failed (%s); "
                    "falling back to per-file scan",
                    err,
                )

    resolved = (
        await scan.resolve_glob(accessor, paths, opts.index) if paths else []
    )
    return await grep_generic(
        resolved,
        texts,
        opts,
        readdir=bound_op(scan.readdir, accessor, opts.index),
        stat=bound_op(scan.stat, accessor, opts.index),
        read_bytes=bound_op(scan.read_bytes, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )
