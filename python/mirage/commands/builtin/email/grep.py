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

from collections.abc import AsyncIterator

from mirage.accessor.email import EmailAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.email._provision import file_read_provision
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.grep_helper import (compile_pattern,
                                                 grep_count_has_matches,
                                                 grep_lines, pattern_arg)
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.email.glob import resolve_glob
from mirage.core.email.read import read as email_read
from mirage.core.email.readdir import readdir as _readdir
from mirage.core.email.scope import EmailScope, detect_scope
from mirage.core.email.search import search_and_format
from mirage.core.email.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


async def grep_provision(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor,
        paths,
        "grep " + " ".join(texts + tuple(str(p) for p in paths)),
        index=index)


@command("grep",
         resource="email",
         spec=SPECS["grep"],
         provision=grep_provision)
async def grep(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    prefix: str = "",
    index: IndexCacheStore = None,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)

    if paths and pattern is not None and "\n" not in pattern and (
            fl.bool("r") or fl.bool("R")):
        scope = detect_scope(paths[0])
        if scope.use_native and scope.folder:
            return await _grep_server_side(accessor,
                                           scope.folder,
                                           pattern,
                                           paths,
                                           i=fl.bool("i"),
                                           v=fl.bool("v"),
                                           n=fl.bool("n"),
                                           c=fl.bool("c"),
                                           args_l=fl.bool("args_l"),
                                           w=fl.bool("w"),
                                           F=fl.bool("F"),
                                           o=fl.bool("o"),
                                           max_count=fl.int("m"))

    resolved = await resolve_glob(accessor, paths, index) if paths else []
    return await generic_grep(
        resolved,
        texts,
        flags,
        readdir=_readdir,
        stat=_stat,
        read_bytes=email_read,
        read_stream=None,
        accessor=accessor,
        stdin=stdin,
        index=index,
    )


async def _grep_server_side(
    accessor: EmailAccessor,
    folder: str,
    pattern: str,
    paths: list[PathSpec],
    i: bool = False,
    v: bool = False,
    n: bool = False,
    c: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    o: bool = False,
    max_count: int | None = None,
) -> tuple[ByteSource | None, IOResult]:
    file_prefix = mount_prefix_of(paths[0].virtual,
                                  paths[0].resource_path) if paths else ""
    pairs = await search_and_format(
        accessor,
        EmailScope(use_native=True, folder=folder),
        pattern,
        file_prefix,
        max_results=accessor.config.max_messages,
    )
    if not pairs:
        return b"", IOResult(exit_code=1)

    pat = compile_pattern(pattern, i, F, w)
    all_results: list[str] = []
    any_match = False
    for vfs_path, msg_text in pairs:
        lines = msg_text.splitlines()
        matched = grep_lines(vfs_path,
                             lines,
                             pat,
                             invert=v,
                             line_numbers=n,
                             count_only=c,
                             files_only=args_l,
                             only_matching=o,
                             max_count=max_count)
        if c:
            all_results.append(f"{vfs_path}:{matched[0]}")
            if grep_count_has_matches(matched):
                any_match = True
            continue
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
