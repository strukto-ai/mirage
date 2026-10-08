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

from mirage.accessor.github import GitHubAccessor
from mirage.commands.builtin.aggregators import prefix_aggregate
from mirage.commands.builtin.generic.grep import grep_generic, labelled
from mirage.commands.builtin.generic_bind.adapter import (
    bound_op,
    mount_io,
    with_command_guards,
    with_policy_guard,
)
from mirage.commands.builtin.github.pushdown import narrow_scope, scope_refusal
from mirage.commands.builtin.grep_pattern import pattern_arg
from mirage.commands.builtin.grep_pushdown import grep_needs_every_file
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.github.constants import SCOPE_ERROR
from mirage.core.github.read import read as github_read
from mirage.core.github.readdir import readdir as github_readdir
from mirage.core.github.stat import stat as github_stat
from mirage.io.types import ByteSource, IOResult
from mirage.ops.namespace_view import paths_scoped
from mirage.types import PathSpec


@command("grep", vfs="github", spec=SPECS["grep"], aggregate=prefix_aggregate)
async def grep(
    accessor: GitHubAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)
    recursive = fl.as_bool("r") or fl.as_bool("R")
    # Code search and the core ops answer from the raw repository, so
    # under a hide or a path rule the scan sets search aside and reads
    # through the command guards, which report a refused directory where
    # GNU does and never open a sealed file.
    scoped = paths_scoped(opts.ns, paths)

    resolved: list[PathSpec] = []
    used_search = False
    if paths:
        resolved, file_count, used_search = await narrow_scope(
            accessor,
            opts.index,
            paths,
            pattern,
            fixed_string=fl.as_bool("F"),
            recursive=recursive,
            whole_word=fl.as_bool("w"),
            exact_file_set=scoped or grep_needs_every_file(fl),
        )
        if used_search and not resolved:
            return b"", IOResult(exit_code=1)
        if file_count > SCOPE_ERROR:
            # A scope this large with no trusted narrowing is refused rather
            # than scanned blob by blob.
            msg = scope_refusal("grep", file_count, fl.as_bool("w"))
            return b"", IOResult(exit_code=1, stderr=msg.encode())

    if used_search:
        opts = labelled(opts)

    io = (
        with_command_guards(with_policy_guard(mount_io(opts)))
        if scoped
        else None
    )
    return await grep_generic(
        resolved,
        texts,
        opts,
        readdir=bound_op(
            io.readdir if io is not None else github_readdir,
            accessor,
            opts.index,
        ),
        stat=bound_op(
            io.stat if io is not None else github_stat, accessor, opts.index
        ),
        read_bytes=bound_op(
            io.read_bytes if io is not None else github_read,
            accessor,
            opts.index,
        ),
        read_stream=None,
        stdin=opts.stdin,
    )
