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
from mirage.commands.builtin.gmail.grep import (
    RG_SEARCH_HONORED,
    SEARCH_MAX_RESULTS,
)
from mirage.commands.builtin.grep_pattern import pattern_arg
from mirage.commands.builtin.grep_pushdown import pushdown_operand
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


async def rg(
    ops: CommandIO,
    accessor: GmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl, "regexp")
    refuse_missing_pattern(pattern_str, fl, parse_flags(fl))
    # Same gate as gmail grep, from the same table: only a lone concrete
    # operand with no reshaping flag may be answered by the search API.
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
        if match.kind in NATIVE_KINDS and (
            match.kind != "root" or not paths_scoped(opts.ns, [operand])
        ):
            file_prefix = (
                mount_prefix_of(operand.virtual, operand.vfs_path) or ""
            )
            vis = check_search([operand])
            rows = await search_messages(
                accessor.token_manager,
                pattern_str,
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
                    rows, match.slots.get("label"), file_prefix, pattern_str
                )
                lines = [text for _, text in visible_results(results, vis)]
                if not lines:
                    return b"", IOResult(exit_code=1)
                return format_records(lines), IOResult()

    resolved = (
        await ops.resolve_glob(accessor, paths, opts.index) if paths else []
    )
    return await rg_generic(
        resolved,
        texts,
        opts,
        readdir=bound_op(ops.readdir, accessor, opts.index),
        stat=bound_op(ops.stat, accessor, opts.index),
        read_bytes=bound_op(ops.read_bytes, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )


BUILDER = Builder("rg", rg, read=True)
