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

from mirage.accessor.email import EmailAccessor
from mirage.commands.builtin.aggregators import prefix_aggregate
from mirage.commands.builtin.email._provision import file_read_provision
from mirage.commands.builtin.email.io import resolve_glob
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.grep_pattern import compile_pattern, pattern_arg
from mirage.commands.builtin.grep_pushdown import (pushdown_operand,
                                                   search_query,
                                                   text_search_results)
from mirage.commands.builtin.grep_scan import grep_lines
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.email.read import read as email_read
from mirage.core.email.readdir import readdir as _readdir
from mirage.core.email.scope import NATIVE_KINDS, detect_scope
from mirage.core.email.search import search_and_format
from mirage.core.email.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

# The email push-down is not a "print the provider's answer" push-down: IMAP
# search only picks the candidate messages, and `grep_lines` then runs the
# real compiled pattern over each one. So the rule for honoring a flag is
# whether it can make a message the search did NOT return contribute output.
# -n/-l/-w/-o/-m cannot: each only narrows within a message already listed,
# and -m is per-file here, which is GNU's own reading of it. -v and -c both
# can, and were wrong before this: -v reports the lines that do not match, so
# it needs every message rather than the ones containing the pattern, and
# GNU's -c prints a `path:0` row for the files with no match at all. They
# defer now, along with -q, -H/-h, -A/-B/-C, rg's -I and the file filters,
# which the open-coded version ignored outright.
SEARCH_HONORED = ("n", "args_l", "w", "o", "m")


async def grep_provision(accessor: EmailAccessor, paths: list[PathSpec],
                         texts: list[str],
                         opts: CommandOpts) -> ProvisionResult:
    line = "grep " + " ".join(list(texts) + [str(p) for p in paths])
    return await file_read_provision(accessor, paths, texts,
                                     replace(opts, command=line))


@command("grep",
         resource="email",
         spec=SPECS["grep"],
         provision=grep_provision,
         aggregate=prefix_aggregate)
async def grep(accessor: EmailAccessor, paths: list[PathSpec],
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)

    # A directory operand is only searched at all under -r/-R, so the
    # push-down waits for it too; every other reason to defer is the shared
    # gate's. A scope that names no folder falls through to the generic scan
    # rather than answering, which is what the mount root does.
    operand = pushdown_operand(paths, opts.flags, pattern, SEARCH_HONORED)
    # IMAP TEXT is a case-insensitive substring search, not a regex engine,
    # so the server is asked for the literal every match must contain and
    # the real pattern runs over each candidate. A pattern with no such
    # literal (an alternation, a class with nothing required around it)
    # takes the generic scan rather than a search for the regex's spelling.
    # grep reads a basic expression unless -E says otherwise, and the
    # literal has to be read off the same dialect the matcher will use.
    basic = not fl.as_bool("E")
    query = (search_query(pattern, fl.as_bool("F"), basic=basic)
             if pattern else None)
    if (pattern is not None and query is not None and operand is not None
            and (fl.as_bool("r") or fl.as_bool("R"))):
        match = detect_scope(operand)
        if match.kind in NATIVE_KINDS:
            result = await _grep_server_side(accessor,
                                             match.slots["folder"],
                                             pattern,
                                             query,
                                             operand,
                                             i=fl.as_bool("i"),
                                             n=fl.as_bool("n"),
                                             args_l=fl.as_bool("args_l"),
                                             w=fl.as_bool("w"),
                                             F=fl.as_bool("F"),
                                             o=fl.as_bool("o"),
                                             max_count=fl.as_int("m"),
                                             basic=basic)

            if result is not None:
                return result

    resolved = await resolve_glob(accessor, paths, opts.index) if paths else []
    return await generic_grep(
        resolved,
        texts,
        opts,
        readdir=bound_op(_readdir, accessor, opts.index),
        stat=bound_op(_stat, accessor, opts.index),
        read_bytes=bound_op(email_read, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )


async def _grep_server_side(
    accessor: EmailAccessor,
    folder: str,
    pattern: str,
    query: str,
    operand: PathSpec,
    i: bool = False,
    n: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    o: bool = False,
    max_count: int | None = None,
    basic: bool = False,
) -> tuple[ByteSource | None, IOResult] | None:
    file_prefix = mount_prefix_of(operand.virtual, operand.resource_path)
    pairs = await search_and_format(
        accessor,
        folder,
        query,
        file_prefix,
        max_results=accessor.config.max_messages,
    )
    if not text_search_results([text for _, text in pairs]):
        return None
    if not pairs:
        return b"", IOResult(exit_code=1)

    # The same dialect the literal was read off: a basic expression
    # compiled as an extended one matches a different language.
    pat = compile_pattern(pattern, i, F, w, basic)
    all_results: list[str] = []
    any_match = False
    for vfs_path, msg_text in pairs:
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
        if all_results:
            return format_records(all_results), IOResult(exit_code=1)
        return b"", IOResult(exit_code=1)
    return format_records(all_results), IOResult()
