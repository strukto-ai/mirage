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

from dulwich.objects import ObjectID
from dulwich.repo import BaseRepo

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.changes import DELETED, work_changes
from mirage.commands.cli.builtin.git.constants import GITLINK
from mirage.commands.cli.builtin.git.errors import (
    AmbiguousArgumentError,
    ConfigUsageError,
    EmptyPathspecError,
    GitError,
    InvalidRevisionNameError,
    UsageError,
)
from mirage.commands.cli.builtin.git.format import abbrev_width
from mirage.commands.cli.builtin.git.ignore import (
    GITIGNORE,
    INFO_EXCLUDE,
    IgnoreStack,
)
from mirage.commands.cli.builtin.git.index_file import read_index
from mirage.commands.cli.builtin.git.io import read_optional
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.pathspec import (
    decoded,
    named_whole,
    narrowed_untracked,
    pathspec_patterns,
    pathspec_selects,
    repo_relative,
    visible_entries,
)
from mirage.commands.cli.builtin.git.ref_list import unique_abbreviations
from mirage.commands.cli.builtin.git.render import quote_path, relative_path
from mirage.commands.cli.builtin.git.repo import config_bool
from mirage.commands.cli.builtin.git.rows import Line, entry_path, printed
from mirage.commands.cli.builtin.git.seen import place_named
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.tree import listed_tree, resolve_tree
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    render_format,
    require_vfs,
    start_point,
    verb_usage,
)
from mirage.commands.cli.builtin.git.worktree import (
    UNTRACKED_ALL,
    UNTRACKED_NO,
    UNTRACKED_NORMAL,
    scan,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult, Rows
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec
from mirage.workspace.files import Files

TAG_CACHED = "H"
TAG_UNMERGED = "M"
TAG_REMOVED = "R"
TAG_MODIFIED = "C"
TAG_OTHER = "?"
LONG_SIZE_WIDTH = 7


def _blob_sizes(
    repo: BaseRepo, rows: list[tuple[str, str, str]]
) -> dict[str, str]:
    """Each blob's size in bytes; a tree or a submodule has none.

    Args:
        repo (BaseRepo): the opened repository.
        rows (list[tuple[str, str, str]]): path, mode and id of each entry.
    """
    return {
        oid: str(len(repo.object_store.get_raw(ObjectID(oid.encode()))[1]))
        for _, mode, oid in rows
        if mode not in ("040000", "160000")
    }


async def _excludes(
    ctx: Context, fl: FlagView, location: RepoLocation
) -> tuple[IgnoreStack, str | None]:
    """The exclude rules the line asks for: none unless it names some.

    Args:
        ctx (Context): the line's context.
        fl (FlagView): parsed flags.
        location (RepoLocation): the discovered repository.

    Returns:
        tuple[IgnoreStack, str | None]: the rules at the top of the tree
            and the exclude file each directory may hold.
    """
    vfs = require_vfs(ctx)
    stack = IgnoreStack([])
    for option, value in fl.occurrences("exclude_from", "exclude_standard"):
        if option == "exclude_standard":
            private = await read_optional(
                vfs, location.commondir.join(INFO_EXCLUDE)
            )
            if private is not None:
                stack = stack.push("", private)
            continue
        for name in value if isinstance(value, list) else [value]:
            data = await read_optional(vfs, start_point(fl).join(str(name)))
            if data is None:
                raise GitError(f"cannot use {name} as an exclude file")
            stack = stack.push("", data)
    per_directory = (
        GITIGNORE
        if fl.as_bool("exclude_standard")
        else fl.as_str("exclude_per_directory")
    )
    if per_directory is not None:
        root = await read_optional(vfs, location.worktree.join(per_directory))
        if root is not None:
            stack = stack.push("", root)
    typed = fl.as_list("exclude")
    if typed:
        text = "".join(f"{pattern}\n" for pattern in typed)
        stack = stack.commanded(encode_text(text))
    return stack, per_directory


async def _tracked_ignored(
    vfs: Files,
    location: RepoLocation,
    stack: IgnoreStack,
    per_directory: str | None,
    names: list[str],
) -> set[str]:
    """Which index paths the exclude rules cover, for ``-i -c``.

    Args:
        vfs (Files): the session's files.
        location (RepoLocation): the discovered repository.
        stack (IgnoreStack): the rules at the top of the tree.
        per_directory (str | None): the exclude file each directory may hold.
        names (list[str]): the repository-relative paths to test.
    """
    stacks = {"": stack}

    async def rules_of(directory: str) -> IgnoreStack:
        known = stacks.get(directory)
        if known is not None:
            return known
        rules = await rules_of(posixpath.dirname(directory))
        if per_directory is not None:
            local = await read_optional(
                vfs, location.worktree.join(directory).join(per_directory)
            )
            if local is not None:
                rules = rules.push(directory, local)
        stacks[directory] = rules
        return rules

    ignored = set()
    for name in names:
        rules = await rules_of(posixpath.dirname(name))
        if rules.is_ignored(name):
            ignored.add(name)
    return ignored


async def ls_files(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """List index paths, and what the work tree holds beside them.

    Without a pathspec the listing is the start directory's subtree;
    with one it is whatever the pathspec names, anywhere in the tree,
    spelled relative to the start directory (``ls-files ..`` from a
    subdirectory prints ``../README.md``). Untracked files come first,
    then each index entry once for every selection it answers to.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the pathspecs.
        ctx (Context): the line's context.
    """
    fl = FlagView(ctx.flags)
    check_switches(ctx, texts)
    others = fl.as_bool("others")
    modified = fl.as_bool("modified")
    deleted = fl.as_bool("deleted")
    ignored = fl.as_bool("ignored")
    unmerged = fl.as_bool("unmerged")
    stage = fl.as_bool("stage") or unmerged
    template = fl.as_str("format")
    tags = fl.as_bool("t") or fl.as_bool("v") or fl.as_bool("f")
    deduplicate = fl.as_bool("deduplicate")
    if template is not None and (stage or others or tags or deduplicate):
        raise UsageError(
            "",
            "fatal: --format cannot be used with -s, -o, -k, -t, "
            f"--resolve-undo, --deduplicate, --eol\n\n{verb_usage(ctx)}",
        )
    cached = fl.as_bool("cached") or (
        fl.as_bool("stage") or not (others or modified or deleted or unmerged)
    )
    if ignored and not (others or fl.as_bool("cached")):
        raise GitError("ls-files -i must be used with either -o or -c")
    repo, location = await opened(ctx, fl)
    vfs = require_vfs(ctx)
    fully = await config_bool(vfs, location, b"core", b"quotepath", True)
    state = await read_index(vfs, location.gitdir)
    start = start_point(fl).virtual
    prefix = repo_relative(location, start, ".")
    patterns = pathspec_patterns(location, start, texts)
    scope = patterns or (prefix,)
    full_name = fl.as_bool("full_name")
    nul = fl.as_bool("z")
    end = "\0" if nul else "\n"
    stack, per_directory = await _excludes(ctx, fl, location)

    def label_of(name: str) -> str:
        shown = name if full_name else relative_path(name, prefix)
        return shown if nul else quote_path(shown, False, fully)

    out: list[Line] = []
    listed: list[str] = []
    changes: dict[str, str] = {}
    if others or modified or deleted:
        tracked = decoded(visible_entries(location, state.entries))
        tracked |= decoded(visible_entries(location, state.conflicts))
        found = await scan(
            vfs,
            location,
            tracked,
            (UNTRACKED_NORMAL if fl.as_bool("directory") else UNTRACKED_ALL)
            if others
            else UNTRACKED_NO,
            ignored,
            None,
            stack,
            per_directory,
            fl.as_bool("directory") and not fl.as_bool("no_empty_directory"),
        )
        changes = await work_changes(
            vfs, location.worktree, state.entries, found
        )
        if others:
            untracked = found.untracked
            if not ignored:
                files: list[str] = []
                if any(
                    name.endswith("/") and not named_whole(name[:-1], scope)
                    for name in untracked
                ):
                    every = await scan(
                        vfs,
                        location,
                        tracked,
                        UNTRACKED_ALL,
                        False,
                        None,
                        stack,
                        per_directory,
                    )
                    files = every.untracked
                untracked = narrowed_untracked(untracked, files, scope)
            for name in sorted(found.ignored if ignored else untracked):
                bare = name.rstrip("/")
                if ignored and not pathspec_selects(bare, scope):
                    continue
                tag = f"{TAG_OTHER} " if tags else ""
                listed.append(bare)
                out.append(
                    Line(
                        location.worktree.join(bare),
                        f"{tag}{label_of(name)}{end}",
                    )
                )
    rows = [(path, 0, entry) for path, entry in state.entries.items()]
    rows.extend(
        (path, number, entry)
        for path, conflict in state.conflicts.items()
        for number, entry in enumerate(
            (conflict.ancestor, conflict.this, conflict.other), 1
        )
        if entry is not None
    )
    rows.sort(key=lambda row: row[:2])
    excluded: set[str] = set()
    if ignored and cached:
        excluded = await _tracked_ignored(
            vfs,
            location,
            stack,
            per_directory,
            [path.decode("utf-8", "surrogateescape") for path, _, _ in rows],
        )
    wanted_abbrev = fl.raw("abbrev")
    width = (
        None
        if wanted_abbrev is None
        else abbrev_width(wanted_abbrev, abbrev_for(repo))
    )
    lengths: dict[str, int] = {}
    if width is not None and stage:
        lengths = await asyncio.to_thread(
            unique_abbreviations,
            repo,
            {row[2].sha.decode(): width for row in rows},
        )
    printed_paths: set[bytes] = set()
    for path, number, entry in rows:
        name = path.decode("utf-8", "surrogateescape")
        if not pathspec_selects(name, scope):
            continue
        if unmerged and number == 0:
            continue
        if ignored and cached and name not in excluded:
            continue
        code = changes.get(name)
        hexid = entry.sha.decode()
        short = hexid[: lengths.get(hexid, len(hexid))]
        selections = (
            (cached or unmerged, TAG_UNMERGED if number else TAG_CACHED),
            (deleted and code == DELETED, TAG_REMOVED),
            (modified and code is not None, TAG_MODIFIED),
        )
        for wanted, letter in selections:
            if not wanted or (deduplicate and path in printed_paths):
                continue
            printed_paths.add(path)
            listed.append(name)
            label = label_of(name)
            if template is not None:
                text = render_format(
                    template,
                    {
                        "objectmode": f"{entry.mode:06o}",
                        "objecttype": "commit"
                        if entry.mode == GITLINK
                        else "blob",
                        "objectname": hexid,
                        "stage": str(number),
                        "path": label,
                    },
                    "ls-files",
                )
            else:
                metadata = (
                    f"{entry.mode:06o} {short} {number}\t" if stage else ""
                )
                tag = f"{letter} " if tags else ""
                text = f"{tag}{metadata}{label}"
            out.append(Line(entry_path(location, path), text + end))
    io = IOResult(rows=Rows(out, printed))
    if fl.as_bool("error_unmatch"):
        missing = [
            typed
            for typed, pattern in zip(texts, patterns, strict=True)
            if not any(pathspec_selects(name, (pattern,)) for name in listed)
        ]
        if missing:
            told = "".join(
                f"error: pathspec '{typed}' did not match any file(s) "
                "known to git\n"
                for typed in missing
            )
            io.exit_code = 1
            io.stderr = encode_text(f"{told}Did you forget to 'git add'?\n")
    return None, io


async def ls_tree(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """List tree metadata without reading file contents.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the tree-ish, then the paths to list.
        ctx (Context): the line's context.
    """
    fl = FlagView(ctx.flags)
    check_switches(ctx, texts)
    if not texts:
        raise UsageError("", verb_usage(ctx))
    repo, location = await opened(ctx, fl)
    assert ctx.vfs is not None
    name, *pathspecs = texts
    try:
        tree = await asyncio.to_thread(resolve_tree, repo, name)
    except (AmbiguousArgumentError, InvalidRevisionNameError) as exc:
        raise GitError(f"Not a valid object name {name}") from exc
    # Each row stands where the tree does, so the hides it is
    # filtered by are the ones at that place, not at the root.
    base = await asyncio.to_thread(place_named, repo, name, tree)
    full_tree = fl.as_bool("full_tree")
    start = location.worktree.virtual if full_tree else start_point(fl).virtual
    prefix = repo_relative(location, start, ".")
    selected: list[str] = []
    for path in pathspecs:
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
    fully = await config_bool(ctx.vfs, location, b"core", b"quotepath", True)
    nul = fl.as_bool("z")
    names = fl.as_bool("name_only") or fl.as_bool("name_status")
    long = fl.as_bool("long")
    object_only = fl.as_bool("object_only")
    template = fl.as_str("format")
    if names and long:
        raise ConfigUsageError(
            "options '--name-only' and '-l' cannot be used together"
        )
    if names and object_only:
        raise ConfigUsageError(
            "options '--name-only' and '--object-only' cannot be used together"
        )
    if template is not None and (names or long or object_only):
        raise UsageError(
            "",
            "fatal: --format can't be combined with other format-altering "
            f"options\n\n{verb_usage(ctx)}",
        )
    full_name = full_tree or fl.as_bool("full_name")
    terminator = "\0" if nul else "\n"
    wanted_abbrev = fl.raw("abbrev")
    width = (
        None
        if wanted_abbrev is None
        else abbrev_width(wanted_abbrev, abbrev_for(repo))
    )
    lengths: dict[str, int] = (
        {}
        if width is None
        else await asyncio.to_thread(
            unique_abbreviations, repo, {row[2]: width for row in rows}
        )
    )
    sizes = (
        await asyncio.to_thread(_blob_sizes, repo, rows)
        if long or (template is not None and "%(objectsize" in template)
        else {}
    )
    out: list[Line] = []
    for path, mode, oid in rows:
        relative = path if full_name else relative_path(path, prefix)
        label = relative if nul else quote_path(relative, False, fully)
        kind = (
            "tree"
            if mode == "040000"
            else "commit"
            if mode == "160000"
            else "blob"
        )
        shown = oid[: lengths.get(oid, len(oid))]
        size = sizes.get(oid, "-")
        padded = size.rjust(LONG_SIZE_WIDTH)
        if template is not None:
            text = (
                render_format(
                    template,
                    {
                        "objectmode": mode,
                        "objecttype": kind,
                        "objectname": shown,
                        "objectsize": size,
                        "objectsize:padded": padded,
                        "path": label,
                    },
                    "ls-tree",
                )
                + terminator
            )
        elif object_only:
            text = shown + terminator
        elif long:
            text = f"{mode} {kind} {shown} {padded}\t{label}{terminator}"
        else:
            text = (
                ("" if names else f"{mode} {kind} {shown}\t")
                + label
                + terminator
            )
        out.append(
            Line(location.worktree.join(posixpath.join(base, path)), text)
        )
    return None, IOResult(rows=Rows(out, printed))
