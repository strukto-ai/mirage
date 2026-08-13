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
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.github.narrow import narrow_scope
from mirage.commands.builtin.grep_helper import pattern_arg
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.github.constants import SCOPE_ERROR
from mirage.core.github.read import read as github_read
from mirage.core.github.readdir import readdir as _readdir
from mirage.core.github.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("rg", resource="github", spec=SPECS["rg"])
async def rg(accessor: GitHubAccessor, paths: list[PathSpec], texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["rg"])
    pattern_str = pattern_arg(texts, fl)
    if pattern_str is None:
        raise UsageError("rg: usage: rg [flags] pattern [path]")

    if paths:
        paths[0]
        paths, file_count, used_search = await narrow_scope(
            accessor,
            opts.index,
            paths,
            pattern_str,
            fixed_string=fl.as_bool("F"),
            recursive=True,
            whole_word=fl.as_bool("w"),
        )
        if file_count > SCOPE_ERROR:
            # Push-down needs -w (see narrow_scope); without it a scope
            # this large has no complete narrowing strategy, so say so
            # rather than scanning thousands of blobs.
            msg = (f"rg: {file_count} files in scope, "
                   "narrow the path, or use -w to enable code search\n")
            return b"", IOResult(exit_code=1, stderr=msg.encode())

    return await generic_rg(
        paths,
        texts,
        opts.flags,
        readdir=bound_op(_readdir, accessor, opts.index),
        stat=bound_op(_stat, accessor, opts.index),
        read_bytes=bound_op(github_read, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )
