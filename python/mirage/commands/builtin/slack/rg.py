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
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.grep_pattern import pattern_arg
from mirage.commands.builtin.grep_pushdown import pushdown_operand
from mirage.commands.builtin.slack.grep import (SEARCH_HONORED,
                                                SEARCH_MAX_RESULTS)
from mirage.commands.builtin.slack.io import resolve_glob
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.slack.formatters import (build_query,
                                          format_file_grep_results,
                                          format_grep_results)
from mirage.core.slack.read import read as slack_read
from mirage.core.slack.readdir import readdir as _readdir
from mirage.core.slack.scope import NATIVE_KINDS, detect_scope, search_target
from mirage.core.slack.search import (search_available, search_files,
                                      search_messages)
from mirage.core.slack.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


@command("rg", resource="slack", spec=SPECS["rg"])
async def rg(accessor: SlackAccessor, paths: list[PathSpec], texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl)
    if pattern_str is None:
        raise UsageError("rg: usage: rg [flags] pattern [path]")

    # Same gate as slack grep, from the same table: only a lone concrete
    # operand with no reshaping flag may be answered by the search API.
    operand = pushdown_operand(paths, opts.flags, pattern_str, SEARCH_HONORED)
    if operand is not None and fl.as_bool("w"):
        match = detect_scope(operand)
        if match.kind in NATIVE_KINDS and search_available(accessor.config):
            target = search_target(match)
            file_prefix = mount_prefix_of(operand.virtual,
                                          operand.resource_path) or ""
            query = build_query(pattern_str, target)
            # Every kind that reaches here searches messages, and each of
            # them (the root, the containers, a channel, a date dir)
            # carries files too, so both halves run.
            native_lines: list[str] = []
            err: Exception | None = None
            try:
                raw = await search_messages(accessor.config,
                                            query,
                                            count=SEARCH_MAX_RESULTS,
                                            session=accessor.pool)
                native_lines.extend(
                    format_grep_results(raw, target, file_prefix))
                raw_f = await search_files(accessor.config,
                                           query,
                                           count=SEARCH_MAX_RESULTS,
                                           session=accessor.pool)
                native_lines.extend(
                    format_file_grep_results(raw_f, target, file_prefix))
            except Exception as exc:
                err = exc
            if err is None:
                if not native_lines:
                    return b"", IOResult(exit_code=1)
                return format_records(native_lines), IOResult()
            logger.warning(
                "slack search push-down failed (%s); "
                "falling back to per-file scan", err)

    resolved = await resolve_glob(accessor, paths, opts.index) if paths else []
    return await generic_rg(
        resolved,
        texts,
        opts,
        readdir=bound_op(_readdir, accessor, opts.index),
        stat=bound_op(_stat, accessor, opts.index),
        read_bytes=bound_op(slack_read, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )
