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

import asyncio
import posixpath

from mirage.commands.cli.builtin.git.errors import (
    AmbiguousArgumentError,
    EmptyPathspecError,
    GitError,
    InvalidRevisionNameError,
    UsageError,
)
from mirage.commands.cli.builtin.git.index_file import read_index
from mirage.commands.cli.builtin.git.pathspec import (
    pathspec_patterns,
    pathspec_selects,
    repo_relative,
    visible_path,
)
from mirage.commands.cli.builtin.git.render import quote_path
from mirage.commands.cli.builtin.git.repo import config_bool
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.tree import listed_tree, resolve_tree
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    fatal,
    start_point,
    verb_usage,
)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text


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
        start = start_point(fl).virtual
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
            if not visible_path(location, name) or not pathspec_selects(
                name, patterns or (prefix,)
            ):
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


async def ls_tree(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """List tree metadata without reading file contents.

    Args:
        inv (CLIInvocation[None]): parsed tree-listing invocation.
    """
    fl = FlagView(inv.flags)
    try:
        check_switches(inv, inv.texts)
        if not inv.texts:
            raise UsageError("", verb_usage(inv))
        doors = inv.doors or CLIDoors()
        repo, location = await opened(fl, doors)
        assert doors.dispatch is not None
        name, *paths = inv.texts
        try:
            tree = await asyncio.to_thread(resolve_tree, repo, name)
        except (AmbiguousArgumentError, InvalidRevisionNameError) as exc:
            raise GitError(f"Not a valid object name {name}") from exc
        full_tree = fl.as_bool("full_tree")
        start = (
            location.worktree.virtual if full_tree else start_point(fl).virtual
        )
        prefix = repo_relative(location, start, ".")
        selected: list[str] = []
        for path in paths:
            if path == "":
                raise EmptyPathspecError()
            relative = repo_relative(location, start, path)
            directory = path.endswith(("/", "/.", "/..")) or path in (
                ".",
                "..",
            )
            selected.append(relative + ("/" if relative and directory else ""))
        patterns = tuple(selected)
        if not patterns and prefix:
            patterns = (prefix + "/",)
        rows = await asyncio.to_thread(
            listed_tree,
            repo,
            tree,
            patterns,
            fl.as_bool("r"),
            fl.as_bool("t"),
            fl.as_bool("d"),
        )
        fully = await config_bool(
            doors.dispatch, location, b"core", b"quotepath", True
        )
        nul = fl.as_bool("z")
        names = fl.as_bool("name_only") or fl.as_bool("name_status")
        full_name = full_tree or fl.as_bool("full_name")
        terminator = "\0" if nul else "\n"
        out: list[str] = []
        for path, mode, oid in rows:
            if not visible_path(location, path):
                continue
            relative = (
                path if full_name else posixpath.relpath(path, prefix or ".")
            )
            label = relative if nul else quote_path(relative, False, fully)
            kind = (
                "tree"
                if mode == "040000"
                else "commit"
                if mode == "160000"
                else "blob"
            )
            out.append(
                ("" if names else f"{mode} {kind} {oid}\t")
                + label
                + terminator
            )
        return encode_text("".join(out)), IOResult()
    except GitError as exc:
        return fatal(exc)
