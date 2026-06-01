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

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.notion._provision import file_read_provision
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.notion.glob import resolve_glob
from mirage.core.notion.read import read as notion_read
from mirage.core.notion.readdir import readdir as _readdir
from mirage.core.notion.scope import detect_scope, scope_warning
from mirage.core.notion.search import format_grep_results, search_page_content
from mirage.core.notion.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def grep_provision(
    accessor: NotionAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    rendered = "grep " + " ".join(texts + tuple(str(p) for p in paths))
    return await file_read_provision(accessor, paths, rendered)


@command("grep",
         resource="notion",
         spec=SPECS["grep"],
         provision=grep_provision)
async def grep(
    accessor: NotionAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    R: bool = False,
    i: bool = False,
    v: bool = False,
    n: bool = False,
    c: bool = False,
    args_l: bool = False,
    w: bool = False,
    F: bool = False,
    E: bool = False,
    o: bool = False,
    m: str | None = None,
    q: bool = False,
    H: bool = False,
    args_h: bool = False,
    A: str | None = None,
    B: str | None = None,
    C: str | None = None,
    e: str | None = None,
    prefix: str = "",
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if e is not None:
        pattern = e
    elif texts:
        pattern = texts[0]
    else:
        raise ValueError("grep: usage: grep [flags] pattern [path]")
    max_count = int(m) if m is not None else None
    after_ctx = int(A) if A is not None else (int(C) if C is not None else 0)
    before_ctx = int(B) if B is not None else (int(C) if C is not None else 0)

    if paths:
        scope = detect_scope(paths[0])
        if scope.use_native:
            file_prefix = paths[0].prefix or ""
            results = await search_page_content(
                accessor.config,
                pattern,
                page_size=max_count or 100,
            )
            lines = format_grep_results(results, file_prefix)
            if not lines:
                return b"", IOResult(exit_code=1)
            return format_records(lines), IOResult()

    resolved = await resolve_glob(accessor, paths, index) if paths else []
    return await generic_grep(
        resolved,
        pattern=pattern,
        readdir=_readdir,
        stat=_stat,
        read_bytes=notion_read,
        read_stream=None,
        accessor=accessor,
        stdin=stdin,
        ignore_case=i,
        invert=v,
        line_numbers=n,
        count_only=c,
        files_only=args_l,
        whole_word=w,
        fixed_string=F,
        only_matching=o,
        quiet=q,
        recursive=r or R,
        max_count=max_count,
        after_context=after_ctx,
        before_context=before_ctx,
        scope_check=scope_warning,
        index=index,
    )
