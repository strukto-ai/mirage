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

import json
from collections.abc import AsyncIterator

from mirage.accessor.email import EmailAccessor
from mirage.cache.index import IndexCacheStore
from mirage.cache.read_through import cache_aware_read_bytes
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.grep_helper import (compile_pattern,
                                                 grep_count_has_matches,
                                                 grep_lines, pattern_arg)
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.email._client import fetch_message
from mirage.core.email.read import read as email_read
from mirage.core.email.readdir import readdir as _readdir
from mirage.core.email.scope import extract_folder
from mirage.core.email.search import _build_vfs_path, search_messages
from mirage.core.email.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("rg", resource="email", spec=SPECS["rg"])
async def rg(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    prefix: str = "",
    index: IndexCacheStore = None,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl)
    if pattern_str is None:
        raise UsageError("rg: usage: rg [flags] pattern [path]")
    i = fl.bool("i")
    v = fl.bool("v")
    n = fl.bool("n")
    c = fl.bool("c")
    args_l = fl.bool("args_l")
    w = fl.bool("w")
    F = fl.bool("F")
    o = fl.bool("o")
    max_count = fl.int("m")
    pat = compile_pattern(pattern_str, i, F, w)

    if paths:
        folder = extract_folder(paths)
        if not folder:
            return b"", IOResult(exit_code=1)

        uids = await search_messages(accessor,
                                     folder,
                                     text=pattern_str,
                                     max_results=accessor.config.max_messages)
        if not uids:
            return b"", IOResult(exit_code=1)

        all_results: list[str] = []
        any_match = False
        file_prefix = paths[0].prefix if paths else ""
        for uid in uids:
            msg = await fetch_message(accessor, folder, uid)
            msg_text = json.dumps(msg,
                                  ensure_ascii=False,
                                  separators=(",", ":"))
            vfs_path = _build_vfs_path(file_prefix, folder, msg)
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
                if not grep_count_has_matches(matched):
                    continue
                any_match = True
                all_results.append(f"{vfs_path}:{matched[0]}")
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
            return b"", IOResult(exit_code=1)
        return format_records(all_results), IOResult()

    return await generic_rg(
        [],
        texts,
        flags,
        readdir=_readdir,
        stat=_stat,
        read_bytes=cache_aware_read_bytes(email_read),
        read_stream=None,
        accessor=accessor,
        stdin=stdin,
        index=index,
    )
