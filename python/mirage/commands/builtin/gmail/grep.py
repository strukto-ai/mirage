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

from dataclasses import replace

from mirage.accessor.gmail import GmailAccessor
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.gmail._provision import file_read_provision
from mirage.commands.builtin.gmail.io import resolve_glob
from mirage.commands.builtin.grep_pattern import pattern_arg
from mirage.commands.builtin.grep_pushdown import (pushdown_operand,
                                                   text_search_results)
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.gmail.read import read as gmail_read
from mirage.core.gmail.readdir import readdir as _readdir
from mirage.core.gmail.scope import NATIVE_KINDS, detect_scope
from mirage.core.gmail.search import format_grep_results, search_messages
from mirage.core.gmail.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

# Gmail search answers with whole messages and the push-down prints that
# answer verbatim, so it can stand in for a scan only when the line names one
# concrete operand and no flag reshapes the output. -w is the exception the
# provider itself supplies: Gmail matches whole words, so a bare literal would
# under-report and only -w makes the two agree.
SEARCH_HONORED = ("w", )
SEARCH_MAX_RESULTS = 50


async def grep_provision(accessor: GmailAccessor, paths: list[PathSpec],
                         texts: list[str],
                         opts: CommandOpts) -> ProvisionResult:
    line = "grep " + " ".join(list(texts) + [str(p) for p in paths])
    return await file_read_provision(accessor, paths, texts,
                                     replace(opts, command=line))


@command("grep", vfs="gmail", spec=SPECS["grep"], provision=grep_provision)
async def grep(accessor: GmailAccessor, paths: list[PathSpec],
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)
    # Output-shaping flags, a glob operand and a multi-operand line all need
    # the generic grep over rendered files; see SEARCH_HONORED above.
    operand = pushdown_operand(paths, opts.flags, pattern, SEARCH_HONORED)
    if pattern is not None and operand is not None and fl.as_bool("w"):
        match = detect_scope(operand)
        if match.kind in NATIVE_KINDS:
            file_prefix = mount_prefix_of(operand.virtual,
                                          operand.vfs_path) or ""
            rows = await search_messages(
                accessor.token_manager,
                pattern,
                label_name=match.slots.get("label"),
                date_str=match.slots.get("day"),
                max_results=SEARCH_MAX_RESULTS,
            )
            lines = format_grep_results(rows, match.slots.get("label"),
                                        file_prefix, pattern)
            if not lines:
                return b"", IOResult(exit_code=1)
            if text_search_results(lines):
                return format_records(lines), IOResult()

    resolved = await resolve_glob(accessor, paths, opts.index) if paths else []
    return await generic_grep(
        resolved,
        texts,
        opts,
        readdir=bound_op(_readdir, accessor, opts.index),
        stat=bound_op(_stat, accessor, opts.index),
        read_bytes=bound_op(gmail_read, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )
