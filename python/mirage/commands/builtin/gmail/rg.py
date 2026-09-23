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
from mirage.commands.builtin.generic.rg import RG_NO_PATTERN
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.gmail.grep import (SEARCH_HONORED,
                                                SEARCH_MAX_RESULTS)
from mirage.commands.builtin.gmail.io import resolve_glob
from mirage.commands.builtin.grep_pattern import pattern_arg
from mirage.commands.builtin.grep_pushdown import pushdown_operand
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.gmail.read import read as gmail_read
from mirage.core.gmail.readdir import readdir as _readdir
from mirage.core.gmail.scope import NATIVE_KINDS, detect_scope
from mirage.core.gmail.search import format_grep_results, search_messages
from mirage.core.gmail.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


@command("rg", vfs="gmail", spec=SPECS["rg"])
async def rg(accessor: GmailAccessor, paths: list[PathSpec], texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl)
    if pattern_str is None:
        raise UsageError(RG_NO_PATTERN)
    # Same gate as gmail grep, from the same table: only a lone concrete
    # operand with no reshaping flag may be answered by the search API.
    operand = pushdown_operand(paths, opts.flags, pattern_str, SEARCH_HONORED)
    if operand is not None and fl.as_bool("w"):
        match = detect_scope(operand)
        if match.kind in NATIVE_KINDS:
            file_prefix = mount_prefix_of(operand.virtual,
                                          operand.vfs_path) or ""
            rows = await search_messages(
                accessor.token_manager,
                pattern_str,
                label_name=match.slots.get("label"),
                date_str=match.slots.get("day"),
                max_results=SEARCH_MAX_RESULTS,
            )
            lines = format_grep_results(rows, match.slots.get("label"),
                                        file_prefix, pattern_str)
            if not lines:
                return b"", IOResult(exit_code=1)
            return format_records(lines), IOResult()

    resolved = await resolve_glob(accessor, paths, opts.index) if paths else []
    return await generic_rg(
        resolved,
        texts,
        opts,
        readdir=bound_op(_readdir, accessor, opts.index),
        stat=bound_op(_stat, accessor, opts.index),
        read_bytes=bound_op(gmail_read, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )
