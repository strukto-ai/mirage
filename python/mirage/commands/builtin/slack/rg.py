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

import logging

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.grep_helper import pattern_arg
from mirage.commands.builtin.slack.io import resolve_glob
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.slack.formatters import (build_query,
                                          format_file_grep_results,
                                          format_grep_results)
from mirage.core.slack.read import read as slack_read
from mirage.core.slack.readdir import readdir as _readdir
from mirage.core.slack.scope import coalesce_scopes, detect_scope
from mirage.core.slack.search import (search_available, search_files,
                                      search_messages)
from mirage.core.slack.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


@command("rg", resource="slack", spec=SPECS["rg"])
async def rg(
    accessor: SlackAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    prefix: str = "",
    index: IndexCacheStore,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl)
    if pattern_str is None:
        raise UsageError("rg: usage: rg [flags] pattern [path]")
    max_count = fl.as_int("m")

    if paths and "\n" not in pattern_str:
        scope = detect_scope(paths[0])
        if not scope.use_native:
            scope = coalesce_scopes(paths) or scope

        if (scope.use_native and getattr(scope, "target", None) != "files"
                and search_available(accessor.config)):
            file_prefix = mount_prefix_of(paths[0].virtual,
                                          paths[0].resource_path) or ""
            query = build_query(pattern_str, scope)
            target = getattr(scope, "target", None)
            do_msgs = target in (None, "date", "messages")
            do_files = target in (None, "date", "files")
            native_lines: list[str] = []
            err: Exception | None = None
            try:
                if do_msgs:
                    raw = await search_messages(accessor.config,
                                                query,
                                                count=max_count or 100)
                    native_lines.extend(
                        format_grep_results(raw, scope, file_prefix))
                if do_files:
                    raw_f = await search_files(accessor.config,
                                               query,
                                               count=max_count or 100)
                    native_lines.extend(
                        format_file_grep_results(raw_f, scope, file_prefix))
            except Exception as exc:
                err = exc
            if err is None:
                if not native_lines:
                    return b"", IOResult(exit_code=1)
                return format_records(native_lines), IOResult()
            logger.warning(
                "slack search push-down failed (%s); "
                "falling back to per-file scan", err)

    resolved = await resolve_glob(accessor, paths, index) if paths else []
    return await generic_rg(
        resolved,
        texts,
        flags,
        readdir=bound_op(_readdir, accessor, index),
        stat=bound_op(_stat, accessor, index),
        read_bytes=bound_op(slack_read, accessor, index),
        read_stream=None,
        stdin=stdin,
    )
