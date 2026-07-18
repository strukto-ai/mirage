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
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.gmail._provision import file_read_provision
from mirage.commands.builtin.gmail.ops import RESOLVE_GLOB as resolve_glob
from mirage.commands.builtin.grep_helper import pattern_arg
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.gmail.read import read as gmail_read
from mirage.core.gmail.readdir import readdir as _readdir
from mirage.core.gmail.scope import detect_scope
from mirage.core.gmail.search import format_grep_results, search_messages
from mirage.core.gmail.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


async def grep_provision(
    accessor: GmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    index: IndexCacheStore,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor,
        paths,
        command="grep " + " ".join(texts + tuple(str(p) for p in paths)),
        index=index)


@command("grep",
         resource="gmail",
         spec=SPECS["grep"],
         provision=grep_provision)
async def grep(
    accessor: GmailAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    prefix: str = "",
    index: IndexCacheStore,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)
    max_count = fl.as_int("m")

    if paths and pattern is not None and "\n" not in pattern:
        scope = detect_scope(paths[0])
        if scope.use_native:
            file_prefix = mount_prefix_of(paths[0].virtual,
                                          paths[0].resource_path) or ""
            rows = await search_messages(
                accessor.token_manager,
                pattern,
                label_name=scope.label_name,
                date_str=scope.date_str,
                max_results=max_count or 50,
            )
            lines = format_grep_results(rows, scope, file_prefix, pattern)
            if not lines:
                return b"", IOResult(exit_code=1)
            return format_records(lines), IOResult()

    resolved = await resolve_glob(accessor, paths, index) if paths else []
    return await generic_grep(
        resolved,
        texts,
        flags,
        readdir=bound_op(_readdir, accessor, index),
        stat=bound_op(_stat, accessor, index),
        read_bytes=bound_op(gmail_read, accessor, index),
        read_stream=None,
        stdin=stdin,
    )
