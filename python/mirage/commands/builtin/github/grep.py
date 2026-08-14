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
from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.github.narrow import narrow_scope
from mirage.commands.builtin.grep_helper import pattern_arg
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.github.constants import SCOPE_ERROR
from mirage.core.github.read import read as github_read
from mirage.core.github.readdir import readdir as github_readdir
from mirage.core.github.stat import stat as github_stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision import ProvisionResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


async def _estimate_recursive(index, path: str) -> tuple[int, int]:
    prefix = path.rstrip("/") + "/"
    total = 0
    ops = 0
    for entry_path, entry in index._entries.items():
        if entry.resource_type != "file":
            continue
        if not entry_path.startswith(prefix):
            continue
        total += entry.size or 0
        ops += 1
    return total, ops


async def grep_provision(
    accessor: GitHubAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> ProvisionResult:
    if not paths:
        return ProvisionResult(command="grep " + " ".join(texts))
    fl = FlagView(opts.flags, spec=SPECS["grep"])
    recursive = fl.as_bool("r") or fl.as_bool("R")
    index = opts.index
    total = 0
    ops = 0
    for p in paths:
        p_prefix = mount_prefix_of(p.virtual, p.resource_path) if isinstance(
            p, PathSpec) else ""
        key = p.virtual if isinstance(p, PathSpec) else str(p)
        if p_prefix and key.startswith(p_prefix):
            key = key[len(p_prefix):] or "/"
        result = await index.get(key)
        if result.entry is None:
            continue
        if result.entry.resource_type == "folder":
            if recursive:
                t, o = await _estimate_recursive(index, key)
                total += t
                ops += o
        else:
            total += result.entry.size or 0
            ops += 1
    return ProvisionResult(
        command=f"grep {texts[0] if texts else ''} ...",
        network_read_low=total,
        network_read_high=total,
        read_ops=ops,
    )


@command("grep",
         resource="github",
         spec=SPECS["grep"],
         provision=grep_provision,
         aggregate=prefix_aggregate)
async def grep(accessor: GitHubAccessor, paths: list[PathSpec],
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["grep"])
    pattern = pattern_arg(texts, fl)
    recursive = fl.as_bool("r") or fl.as_bool("R")

    resolved: list[PathSpec] = []
    if paths:
        resolved, file_count, used_search = await narrow_scope(
            accessor,
            opts.index,
            paths,
            pattern,
            fixed_string=fl.as_bool("F"),
            recursive=recursive,
            whole_word=fl.as_bool("w"),
        )
        if file_count > SCOPE_ERROR:
            # Push-down needs -w (see narrow_scope); without it a scope
            # this large has no complete narrowing strategy, so say so
            # rather than scanning thousands of blobs.
            msg = (f"grep: {file_count} files in scope, "
                   "narrow the path, or use -w to enable code search\n")
            return b"", IOResult(exit_code=1, stderr=msg.encode())

    return await generic_grep(
        resolved,
        texts,
        opts.flags,
        readdir=bound_op(github_readdir, accessor, opts.index),
        stat=bound_op(github_stat, accessor, opts.index),
        read_bytes=bound_op(github_read, accessor, opts.index),
        read_stream=None,
        stdin=opts.stdin,
    )
