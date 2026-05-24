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
from mirage.commands.builtin.grep_helper import compile_pattern, grep_lines
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.email._client import fetch_message
from mirage.core.email.scope import extract_folder
from mirage.core.email.search import _build_vfs_path, search_messages
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("rg", resource="email", spec=SPECS["rg"])
async def rg(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    i: bool = False,
    v: bool = False,
    n: bool = False,
    c: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    o: bool = False,
    m: str | None = None,
    A: str | None = None,
    B: str | None = None,
    C: str | None = None,
    hidden: bool = False,
    type: str | None = None,
    glob: str | None = None,
    prefix: str = "",
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("rg: usage: rg [flags] pattern [path]")
    pattern_str = texts[0]
    max_count = int(m) if m is not None else None
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
            msg_text = json.dumps(msg, ensure_ascii=False)
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
            if not matched:
                continue
            any_match = True
            if args_l:
                all_results.append(vfs_path)
                continue
            if c:
                all_results.append(f"{vfs_path}:{len(matched)}")
                continue
            for line in matched:
                all_results.append(f"{vfs_path}:{line}")
        if not any_match:
            return b"", IOResult(exit_code=1)
        return "\n".join(all_results).encode(), IOResult()

    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("rg: usage: rg [flags] pattern path")
    lines = raw.decode(errors="replace").splitlines()
    matched = grep_lines("<stdin>",
                         lines,
                         pat,
                         invert=v,
                         line_numbers=n,
                         count_only=c,
                         files_only=args_l,
                         only_matching=o,
                         max_count=max_count)
    if not matched:
        return b"", IOResult(exit_code=1)
    if c:
        return str(len(matched)).encode(), IOResult()
    return "\n".join(matched).encode(), IOResult()
