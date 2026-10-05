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

import posixpath

from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.index_file import read_index
from mirage.commands.cli.builtin.git.pathspec import (
    pathspec_patterns,
    pathspec_selects,
    repo_relative,
)
from mirage.commands.cli.builtin.git.render import quote_path
from mirage.commands.cli.builtin.git.repo import config_bool
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    fatal,
    start_point,
)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult


async def ls_files(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """List index paths, including conflict stages when requested.

    Without a pathspec the listing is the start directory's subtree;
    with one it is whatever the pathspec names, anywhere in the tree,
    spelled relative to the start directory (``ls-files ..`` from a
    subdirectory prints ``../README.md``).

    Args:
        inv (CLIInvocation[None]): parsed index-listing invocation.
    """
    fl = FlagView(inv.flags)
    try:
        check_switches(inv, inv.texts)
        doors = inv.doors or CLIDoors()
        _, location = await opened(fl, doors)
        assert doors.dispatch is not None
        fully = await config_bool(
            doors.dispatch, location, b"core", b"quotepath", True
        )
        state = await read_index(doors.dispatch, location.gitdir)
        start = start_point(fl)
        prefix = repo_relative(location, start, ".")
        patterns = pathspec_patterns(location, start, inv.texts)
        rows = [(path, 0, entry) for path, entry in state.entries.items()]
        rows.extend(
            (path, stage, entry)
            for path, conflict in state.conflicts.items()
            for stage, entry in enumerate(
                (conflict.ancestor, conflict.this, conflict.other), 1
            )
            if entry is not None
        )
        nul = fl.as_bool("z")
        out = []
        for path, stage, entry in sorted(rows, key=lambda row: row[:2]):
            name = path.decode("utf-8", "surrogateescape")
            if not pathspec_selects(name, patterns or (prefix,)):
                continue
            relative = posixpath.relpath(name, prefix or ".")
            label = relative if nul else quote_path(relative, False, fully)
            metadata = ""
            if fl.as_bool("stage"):
                metadata = f"{entry.mode:06o} {entry.sha.decode()} {stage}\t"
            out.append(metadata + label + ("\0" if nul else "\n"))
        return "".join(out).encode("utf-8", "surrogateescape"), IOResult()
    except GitError as exc:
        return fatal(exc)
