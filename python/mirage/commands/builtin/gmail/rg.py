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

from mirage.accessor.gmail import GmailAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.grep_helper import pattern_arg
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.gmail.glob import resolve_glob
from mirage.core.gmail.read import read as gmail_read
from mirage.core.gmail.readdir import readdir as _readdir
from mirage.core.gmail.scope import detect_scope
from mirage.core.gmail.search import format_grep_results, search_messages
from mirage.core.gmail.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


@command("rg", resource="gmail", spec=SPECS["rg"])
async def rg(
    accessor: GmailAccessor,
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
    max_count = fl.int("m")

    if paths and "\n" not in pattern_str:
        scope = detect_scope(paths[0])
        if scope.use_native:
            file_prefix = mount_prefix_of(paths[0].virtual,
                                          paths[0].resource_path) or ""
            rows = await search_messages(
                accessor.token_manager,
                pattern_str,
                label_name=scope.label_name,
                date_str=scope.date_str,
                max_results=max_count or 50,
            )
            lines = format_grep_results(rows, scope, file_prefix, pattern_str)
            if not lines:
                return b"", IOResult(exit_code=1)
            return format_records(lines), IOResult()

    resolved = await resolve_glob(accessor, paths, index) if paths else []
    return await generic_rg(
        resolved,
        texts,
        flags,
        readdir=_readdir,
        stat=_stat,
        read_bytes=gmail_read,
        read_stream=None,
        accessor=accessor,
        stdin=stdin,
        index=index,
    )
