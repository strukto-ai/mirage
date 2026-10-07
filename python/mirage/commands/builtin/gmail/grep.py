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

from mirage.accessor.gmail import GmailAccessor
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
from mirage.core.gmail.scope import NATIVE_KINDS, detect_scope
from mirage.core.gmail.search import format_grep_results, search_messages
from mirage.io.types import ByteSource, IOResult
from mirage.ops.namespace_view import paths_scoped
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.vfs.search import check_search, search_scoped, visible_results

# Gmail search answers with whole messages and the push-down prints that
# answer verbatim, so it can stand in for a scan only when the line names one
# concrete operand and no flag reshapes the output. -w is the exception the
# provider itself supplies: Gmail matches whole words, so a bare literal would
# under-report and only -w makes the two agree.
SEARCH_HONORED = ("w",)
# rg spells the same flag by its long name.
RG_SEARCH_HONORED = ("word_regexp",)
SEARCH_MAX_RESULTS = 50


async def grep(
    ops: CommandIO,
    accessor: GmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)
    # Output-shaping flags, a glob operand and a multi-operand line all need
    # the generic grep over rendered files; see SEARCH_HONORED above.
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
        if match.kind in NATIVE_KINDS and (
            match.kind != "root" or not paths_scoped(opts.ns, [operand])
        ):
            file_prefix = (
                mount_prefix_of(operand.virtual, operand.vfs_path) or ""
            )
            vis = check_search([operand])
            rows = await search_messages(
                accessor.token_manager,
                pattern,
                label_name=match.slots.get("label"),
                date_str=match.slots.get("day"),
                max_results=SEARCH_MAX_RESULTS,
            )
            # Incomplete or unaddressable hits need the guarded walk; a
            # guessed path cannot establish visibility.
            complete = len(rows) < SEARCH_MAX_RESULTS and all(
                row.get("date") for row in rows
            )
            if not paths_scoped(opts.ns, [operand]) or complete:
                results = format_grep_results(
                    rows, match.slots.get("label"), file_prefix, pattern
                )
                lines = [text for _, text in visible_results(results, vis)]
                if not lines:
                    return b"", IOResult(exit_code=1)
                if text_search_results(lines):
                    return format_records(lines), IOResult()

    resolved = (
        await ops.resolve_glob(accessor, paths, opts.index) if paths else []
    )
    return await grep_generic(
        resolved,
        texts,
        opts,
        readdir=bound_op(ops.readdir, accessor, opts.index),
        stat=bound_op(ops.stat, accessor, opts.index),
        read_bytes=bound_op(ops.read_bytes, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )


BUILDER = Builder("grep", grep, read=True)
