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

from mirage.accessor.email import EmailAccessor
from mirage.commands.builtin.email.grep import SEARCH_HONORED
from mirage.commands.builtin.email.io import resolve_glob
from mirage.commands.builtin.generic.rg import RG_NO_PATTERN
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.grep_pattern import compile_pattern, pattern_arg
from mirage.commands.builtin.grep_pushdown import (pushdown_operand,
                                                   search_query)
from mirage.commands.builtin.grep_scan import grep_lines
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.client import fetch_message
from mirage.core.email.read import read as email_read
from mirage.core.email.readdir import readdir as _readdir
from mirage.core.email.render import message_json_text
from mirage.core.email.scope import NATIVE_KINDS, detect_scope
from mirage.core.email.search import _build_vfs_path, search_messages
from mirage.core.email.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


@command("rg", vfs="email", spec=SPECS["rg"])
async def rg(accessor: EmailAccessor, paths: list[PathSpec], texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl)
    if pattern_str is None:
        raise UsageError(RG_NO_PATTERN)
    i = fl.as_bool("i")
    n = fl.as_bool("n")
    args_l = fl.as_bool("args_l")
    w = fl.as_bool("w")
    F = fl.as_bool("F")
    o = fl.as_bool("o")
    max_count = fl.as_int("m")
    pat = compile_pattern(pattern_str, i, F, w)

    # IMAP text search takes one pattern; a newline-joined multi -e set must
    # fall through to the generic so each pattern matches (#347). The rest of
    # the gate is grep's, from the same table, and reads the scope the same
    # way: a line the push-down cannot answer takes the generic scan below.
    # It used to return exit 1 instead, reporting "nothing matched" for a
    # search it had not run.
    operand = pushdown_operand(paths, opts.flags, pattern_str, SEARCH_HONORED)
    # The server is asked for the literal every match must contain, never
    # the regex's own spelling: IMAP TEXT is a substring search.
    query = search_query(pattern_str, F)
    match = detect_scope(operand) if operand is not None else None
    if (operand is not None and query is not None and match is not None
            and match.kind in NATIVE_KINDS):
        folder = match.slots["folder"]
        uids = await search_messages(accessor,
                                     folder,
                                     text=query,
                                     max_results=accessor.config.max_messages)
        if not uids:
            return b"", IOResult(exit_code=1)

        all_results: list[str] = []
        any_match = False
        file_prefix = mount_prefix_of(operand.virtual, operand.vfs_path)
        for uid in uids:
            msg = await fetch_message(accessor, folder, uid)
            msg_text = message_json_text(msg)
            vfs_path = _build_vfs_path(file_prefix, folder, msg)
            lines = msg_text.splitlines()
            matched = grep_lines(vfs_path,
                                 lines,
                                 pat,
                                 invert=False,
                                 line_numbers=n,
                                 count_only=False,
                                 files_only=args_l,
                                 only_matching=o,
                                 max_count=max_count)
            if not matched:
                continue
            any_match = True
            if args_l:
                all_results.append(vfs_path)
                continue
            for line in matched:
                all_results.append(f"{vfs_path}:{line}")
        if not any_match:
            return b"", IOResult(exit_code=1)
        return format_records(all_results), IOResult()

    resolved = await resolve_glob(accessor, paths, opts.index) if paths else []
    return await generic_rg(
        resolved,
        texts,
        opts,
        readdir=bound_op(_readdir, accessor, opts.index),
        stat=bound_op(_stat, accessor, opts.index),
        read_bytes=bound_op(email_read, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )
