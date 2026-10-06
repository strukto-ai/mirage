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

import stat
from dataclasses import dataclass, replace
from io import BytesIO

from dulwich.config import ConfigFile
from dulwich.diff_tree import _similarity_score
from dulwich.objects import Commit, ObjectID, Tree
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.changes import pair_renames
from mirage.commands.cli.builtin.git.combined import combined_lines
from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.io import read_optional
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.patch import (
    DEV_NULL,
    HUNK_CONTEXT,
    OID_HEX,
    blob_data,
    file_patch,
    short_oid,
)
from mirage.commands.cli.builtin.git.pathspec import pathspec_selects
from mirage.commands.cli.builtin.git.render import quote_path
from mirage.commands.cli.builtin.git.summary import (
    FileStat,
    diffstat,
    stat_table,
)
from mirage.commands.cli.builtin.git.tree import tree_entries
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.spec.flag_view import FlagView
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.utils.path import join_spec

RENAME_SCORE = 50


@dataclass(frozen=True, slots=True)
class DiffFlags:
    """One interpretation of Git diff options, shared by all tree readers."""

    name_only: bool = False
    name_status: bool = False
    stat: bool = False
    numstat: bool = False
    shortstat: bool = False
    summary: bool = False
    patch: bool = False
    no_patch: bool = False
    renames: int | None = None
    merge: str = "off"
    raw: bool = False
    abbrev: bool = False
    function_context: bool = False
    context: int = HUNK_CONTEXT
    quote_path_fully: bool = True
    pathspecs: tuple[str, ...] = ()


def parse_diff_flags(
    fl: FlagView,
    *,
    default_patch: bool = True,
    default_merge: str = "off",
    porcelain: bool = True,
    default_renames: bool = True,
    quote_path_fully: bool = True,
) -> DiffFlags:
    modes = [
        fl.as_bool(key)
        for key in (
            "name_only",
            "name_status",
            "stat",
            "numstat",
            "shortstat",
            "summary",
            "raw",
        )
    ]
    rename = fl.raw("find_renames")
    threshold = None
    if rename is not None and rename is not False:
        threshold = RENAME_SCORE
        if isinstance(rename, str) and rename:
            value = rename.removesuffix("%")
            try:
                threshold = (
                    int(value)
                    if rename.endswith("%")
                    else int(float("0." + value) * 100)
                )
            except ValueError as exc:
                raise GitError(f"invalid similarity index {rename}") from exc
    elif porcelain and default_renames:
        threshold = RENAME_SCORE
    if fl.as_bool("no_renames"):
        threshold = None
    merge = fl.as_str("diff_merges") or default_merge
    if fl.as_bool("m"):
        merge = "separate"
    if fl.as_bool("c"):
        merge = "combined"
    if fl.as_bool("cc"):
        merge = "dense-combined"
    if porcelain and fl.as_bool("first_parent"):
        merge = "first-parent"
    merge = {
        "0": "off",
        "1": "separate",
        "on": "separate",
        "m": "separate",
        "c": "combined",
        "cc": "dense-combined",
    }.get(merge, merge)
    if merge not in (
        "off",
        "separate",
        "combined",
        "dense-combined",
        "first-parent",
    ):
        raise GitError(f"invalid value for --diff-merges: {merge}")
    context = fl.as_int("unified")
    if context is not None and context < 0:
        raise GitError("negative context length")
    patch = (
        fl.as_bool("patch")
        or fl.as_bool("function_context")
        or context is not None
        or (
            (
                default_patch
                or fl.as_bool("cc")
                or (porcelain and fl.as_bool("c"))
            )
            and not any(modes)
        )
    )
    return DiffFlags(
        function_context=fl.as_bool("function_context"),
        context=HUNK_CONTEXT if context is None else context,
        name_only=modes[0],
        name_status=modes[1],
        stat=modes[2],
        numstat=modes[3],
        shortstat=modes[4],
        summary=modes[5],
        patch=patch,
        no_patch=fl.as_bool("no_patch"),
        renames=threshold,
        merge=merge,
        raw=modes[6] or not porcelain and not any(modes) and not patch,
        abbrev=porcelain,
        quote_path_fully=quote_path_fully,
    )


@dataclass(frozen=True, slots=True)
class Change:
    """A paired tree delta; every output format consumes these same rows."""

    path: bytes
    old_path: bytes
    old: tuple[int, bytes] | None
    new: tuple[int, bytes] | None
    status: str
    score: int = 0


def compare(
    repo: BaseRepo,
    before: dict[bytes, tuple[int, bytes]],
    after: dict[bytes, tuple[int, bytes]],
    threshold: int | None,
) -> list[Change]:
    changed = sorted(
        p for p in set(before) | set(after) if before.get(p) != after.get(p)
    )
    names = {p.decode("utf-8", errors="surrogateescape"): p for p in changed}
    codes = {
        name: (
            "A"
            if p not in before
            else "D"
            if p not in after
            else "T"
            if before[p][0] & 0o170000 != after[p][0] & 0o170000
            else "M"
        )
        for name, p in names.items()
    }
    entries = {name: after.get(p, before.get(p)) for name, p in names.items()}
    pairs = (
        {p: (code, None) for p, code in codes.items()}
        if threshold is None
        else pair_renames(
            repo.object_store,
            codes,
            {p: e[1] for p, e in entries.items() if e is not None},
            {p: e[0] & 0o170000 for p, e in entries.items() if e is not None},
            threshold,
        )
    )
    rows = []
    for path, (status, origin) in sorted(
        pairs.items(), key=lambda item: names[item[0]]
    ):
        name, old_path = names[path], names[origin or path]
        old, new = before.get(old_path), after.get(name)
        score = 0
        if origin is not None and old is not None and new is not None:
            score = (
                100
                if old[1] == new[1]
                else _similarity_score(
                    repo.object_store[ObjectID(old[1])],
                    repo.object_store[ObjectID(new[1])],
                )
            )
        rows.append(Change(name, old_path, old, new, status, score))
    return rows


def rename_name(old: str, new: str, fully: bool = True) -> str:
    """How a rename names its paths in a diffstat, git's pprint_rename.

    When either side needs quoting the two quoted paths stand whole;
    otherwise the shared leading and trailing directories fold into
    ``pre/{old => new}/post``.

    Args:
        old (str): the source path, surrogate-escaped.
        new (str): the destination path, surrogate-escaped.
        fully (bool): ``core.quotePath``.
    """
    quoted_old = quote_path(old, False, fully)
    quoted_new = quote_path(new, False, fully)
    if quoted_old != old or quoted_new != new:
        return f"{quoted_old} => {quoted_new}"
    a, b = old.split("/"), new.split("/")
    prefix = []
    while len(a) > 1 and len(b) > 1 and a[0] == b[0]:
        prefix.append(a.pop(0))
        b.pop(0)
    suffix: list[str] = []
    while len(a) > 1 and len(b) > 1 and a[-1] == b[-1]:
        suffix.insert(0, a.pop())
        b.pop()
    middle = "/".join(a) + " => " + "/".join(b)
    return (
        "/".join([*prefix, "{" + middle + "}", *suffix])
        if prefix or suffix
        else middle
    )


def render_changes(
    repo: BaseRepo, rows: list[Change], flags: DiffFlags
) -> bytes:
    """Every requested format for one two-tree comparison, in git's order.

    ``--name-only`` and ``--name-status`` stand alone; otherwise raw
    rows come first, then numstat, stat and summary, then a blank line
    and the patch.

    Args:
        repo (BaseRepo): repository to read blobs from.
        rows (list[Change]): the paired tree deltas.
        flags (DiffFlags): the parsed invocation.
    """
    if flags.no_patch:
        return b""
    width = abbrev_for(repo) if flags.abbrev else OID_HEX
    fully = flags.quote_path_fully
    lines: list[str] = []
    stats: list[FileStat] = []
    numbers: list[str] = []
    summaries: list[str] = []
    patches: list[bytes] = []
    for row in rows:
        name = row.path.decode("utf-8", errors="surrogateescape")
        origin = row.old_path.decode("utf-8", errors="surrogateescape")
        shown = quote_path(name, False, fully)
        status = f"R{row.score:03d}" if row.status == "R" else row.status
        paths = (
            f"{quote_path(origin, False, fully)}\t{shown}"
            if row.status == "R"
            else shown
        )
        if flags.name_only:
            lines.append(shown)
            continue
        if flags.name_status:
            lines.append(f"{status}\t{paths}")
            continue
        if flags.raw:
            lines.append(
                f":{_mode(row.old):06o} {_mode(row.new):06o} "
                f"{short_oid(row.old, width)} {short_oid(row.new, width)} "
                f"{status}\t{paths}"
            )
        display = (
            rename_name(origin, name, fully) if row.status == "R" else shown
        )
        if flags.stat or flags.numstat or flags.shortstat:
            stats.append(_row_stat(repo, row, display))
        if flags.numstat:
            counts = (
                "-\t-"
                if stats[-1].binary
                else f"{stats[-1].insertions}\t{stats[-1].deletions}"
            )
            numbers.append(f"{counts}\t{display}")
        if flags.summary:
            summaries.extend(_summary(row, display, shown))
        if flags.patch:
            patches.append(
                file_patch(
                    repo,
                    name,
                    origin,
                    row.old,
                    row.new,
                    row.score if row.status == "R" else None,
                    abbrev_for(repo),
                    fully,
                    flags.context,
                    flags.function_context,
                )
            )
    if not (flags.name_only or flags.name_status):
        table = stat_table(stats)
        lines += (
            numbers
            + (table if flags.stat else table[-1:] if flags.shortstat else [])
            + summaries
        )
    output = encode_text("".join(line + "\n" for line in lines))
    body = b"".join(patches)
    return output + (b"\n" if output and body else b"") + body


def commit_summary(
    repo: BaseRepo,
    before: dict[bytes, tuple[int, bytes]],
    after: dict[bytes, tuple[int, bytes]],
    fully: bool = True,
) -> bytes:
    """The counts and summary lines ``git commit`` prints under its title.

    ``--shortstat --summary`` of the change, with renames found at git's
    default score whatever ``diff.renames`` says, which is how git's
    commit summary reads (pinned against git 2.50).

    Args:
        repo (BaseRepo): repository to read blobs from.
        before (dict): the parent tree, path to (mode, blob id).
        after (dict): the new tree, path to (mode, blob id).
        fully (bool): ``core.quotePath``.
    """
    return render_changes(
        repo,
        compare(repo, before, after, RENAME_SCORE),
        DiffFlags(shortstat=True, summary=True, quote_path_fully=fully),
    )


def _mode(entry: tuple[int, bytes] | None) -> int:
    """An entry's mode, zero for the side that does not exist.

    Args:
        entry (tuple[int, bytes] | None): the (mode, id) pair or None.
    """
    return entry[0] if entry else 0


def _row_stat(repo: BaseRepo, row: Change, display: str) -> FileStat:
    """The diffstat row for one change, named the way git prints it.

    Args:
        repo (BaseRepo): repository to read blobs from.
        row (Change): the paired delta.
        display (str): the quoted or rename-folded name.
    """
    before = {row.path: row.old} if row.old else {}
    after = {row.path: row.new} if row.new else {}
    counted = diffstat(repo.object_store, before, after)
    if counted:
        return replace(counted[0], path=display)
    fresh = diffstat(repo.object_store, {}, after)[0]
    return replace(
        fresh, path=display, insertions=0, deletions=0, old_size=fresh.new_size
    )


def _summary(row: Change, display: str, shown: str) -> list[str]:
    """The ``--summary`` lines for one change, git's diff_summary.

    Args:
        row (Change): the paired delta.
        display (str): the rename-folded name.
        shown (str): the quoted destination path.
    """
    old, new = row.old, row.new
    if row.status == "R":
        lines = [f" rename {display} ({row.score}%)"]
        if old and new and old[0] != new[0]:
            lines.append(f" mode change {old[0]:06o} => {new[0]:06o}")
        return lines
    if old is None and new:
        return [f" create mode {new[0]:06o} {shown}"]
    if new is None and old:
        return [f" delete mode {old[0]:06o} {shown}"]
    if old and new and old[0] != new[0]:
        return [f" mode change {old[0]:06o} => {new[0]:06o} {shown}"]
    return []


def entries(
    repo: BaseRepo,
    tree: bytes | None,
    recursive: bool,
    pathspecs: tuple[str, ...] = (),
) -> dict[bytes, tuple[int, bytes]]:
    """A tree's entries a diff compares, limited to a pathspec.

    Args:
        repo (BaseRepo): repository to read.
        tree (bytes | None): the tree id, None for the empty tree.
        recursive (bool): whether to descend into subtrees.
        pathspecs (tuple[str, ...]): repository-relative patterns, all
            paths when empty.
    """
    if recursive or tree is None:
        found = tree_entries(repo.object_store, tree)
    else:
        obj = repo.object_store[ObjectID(tree)]
        assert isinstance(obj, Tree)
        found = {e.path: (e.mode, e.sha) for e in obj.iteritems()}
    return limited(found, pathspecs)


def limited(
    found: dict[bytes, tuple[int, bytes]], pathspecs: tuple[str, ...]
) -> dict[bytes, tuple[int, bytes]]:
    """The entries a pathspec names, all of them for none.

    Applied before pairing, so a rename is found only where both paths
    match (pinned against git 2.54).

    Args:
        found (dict[bytes, tuple[int, bytes]]): path to (mode, id).
        pathspecs (tuple[str, ...]): repository-relative patterns.
    """
    if not pathspecs:
        return found
    return {
        path: entry
        for path, entry in found.items()
        if pathspec_selects(
            path.decode("utf-8", errors="surrogateescape"),
            pathspecs,
            stat.S_ISDIR(entry[0]),
        )
    }


def _block(
    repo: BaseRepo,
    before: bytes | None,
    after: bytes,
    flags: DiffFlags,
    recursive: bool = True,
) -> bytes | None:
    """One parent's diff block, None when the commit does not differ.

    Args:
        repo (BaseRepo): repository to read.
        before (bytes | None): the parent's tree, None for a root.
        after (bytes): the commit's tree.
        flags (DiffFlags): the diff flags.
        recursive (bool): whether to descend into subtrees.
    """
    rows = compare(
        repo,
        entries(repo, before, recursive, flags.pathspecs),
        entries(repo, after, recursive, flags.pathspecs),
        flags.renames,
    )
    return render_changes(repo, rows, flags) if rows else None


def commit_output(
    repo: BaseRepo,
    commit: Commit,
    flags: DiffFlags,
    recursive: bool = True,
    root: bool = True,
) -> list[bytes | None]:
    """A commit's diff blocks, one per parent the merge mode compares.

    A parent the commit does not differ from is None, so its header is
    not printed either (pinned against git 2.54).

    Args:
        repo (BaseRepo): repository to read.
        commit (Commit): the commit to diff.
        flags (DiffFlags): the diff flags.
        recursive (bool): whether to descend into subtrees.
        root (bool): whether a root commit diffs against the empty tree.
    """
    parents = [repo.object_store[p] for p in commit.parents]
    assert all(isinstance(p, Commit) for p in parents)
    trees = [p.tree for p in parents if isinstance(p, Commit)]
    if not trees:
        return (
            [_block(repo, None, commit.tree, flags, recursive)] if root else []
        )
    if len(trees) == 1 or flags.merge == "first-parent":
        return [_block(repo, trees[0], commit.tree, flags, recursive)]
    if flags.merge == "off":
        return []
    if flags.merge == "separate":
        return [
            _block(repo, tree, commit.tree, flags, recursive) for tree in trees
        ]
    after = entries(repo, commit.tree, recursive, flags.pathspecs)
    comparisons = [
        compare(
            repo,
            entries(repo, tree, recursive, flags.pathspecs),
            after,
            flags.renames,
        )
        for tree in trees
    ]
    common = set.intersection(
        *({row.path for row in rows} for rows in comparisons)
    )
    maps = [{row.path: row for row in rows} for rows in comparisons]
    if flags.no_patch:
        return []
    width = abbrev_for(repo) if flags.abbrev else OID_HEX
    names = flags.name_only or flags.name_status
    stat = (
        render_changes(
            repo, comparisons[0], replace(flags, patch=False, raw=False)
        )
        if (
            not names
            and any(
                (flags.stat, flags.numstat, flags.shortstat, flags.summary)
            )
        )
        else b""
    )
    lines = []
    for path in sorted(common) if names or flags.raw else []:
        status = "".join(m[path].status for m in maps)
        shown = quote_path(
            path.decode("utf-8", errors="surrogateescape"),
            False,
            flags.quote_path_fully,
        )
        if flags.name_only:
            lines.append(shown)
        elif flags.name_status:
            lines.append(f"{status}\t{shown}")
        else:
            sides = [*(m[path].old for m in maps), maps[0][path].new]
            lines.append(
                ":" * len(maps)
                + " ".join(f"{_mode(e):06o}" for e in sides)
                + " "
                + " ".join(short_oid(e, width) for e in sides)
                + f" {status}\t{shown}"
            )
    head = stat + encode_text("".join(line + "\n" for line in lines))
    patch = (
        combined_patch(
            repo,
            maps,
            common,
            flags.merge == "dense-combined",
            flags.quote_path_fully,
            flags.context,
        )
        if flags.patch and not names
        else b""
    )
    return [head + (b"\n" if head and patch else b"") + patch]


def combined_patch(
    repo: BaseRepo,
    maps: list[dict[bytes, Change]],
    paths: set[bytes],
    dense: bool,
    fully: bool = True,
    context: int = HUNK_CONTEXT,
) -> bytes:
    """Render ``-c``/``--cc`` for the paths that differ from every parent.

    A path with no hunk left and no mode change prints nothing at all,
    and the headers follow git's show_combined_header.

    Args:
        repo (BaseRepo): repository to read blobs from.
        maps (list[dict[bytes, Change]]): per parent, its rows by path.
        paths (set[bytes]): the paths changed against every parent.
        dense (bool): ``--cc`` rather than ``-c``.
        fully (bool): ``core.quotePath``.
        context (int): the requested number of context lines.
    """
    out = []
    for path in sorted(paths):
        changes = [m[path] for m in maps]
        new = changes[0].new
        old = [row.old for row in changes]
        new_data = blob_data(repo, new)
        old_data = [blob_data(repo, entry) for entry in old]
        binary = any(b"\0" in data[:8000] for data in [*old_data, new_data])
        body = (
            []
            if binary
            else combined_lines(
                [text_lines(data) for data in old_data],
                text_lines(new_data),
                dense,
                context,
            )
        )
        mode = new[0] if new else 0
        moved = any((entry[0] if entry else 0) != mode for entry in old)
        if not (binary or body or moved):
            continue
        deleted = new is None
        created = not deleted and all(row.status == "A" for row in changes)
        name = path.decode("utf-8", errors="surrogateescape")
        width = abbrev_for(repo)
        out.append(
            f"diff --{'cc' if dense else 'combined'} "
            f"{quote_path(name, False, fully)}\n"
        )
        out.append(
            "index "
            + ",".join(short_oid(entry, width) for entry in old)
            + ".."
            + short_oid(new, width)
            + "\n"
        )
        if moved and created:
            out.append(f"new file mode {mode:06o}\n")
        elif moved:
            out.append(
                ("deleted file mode " if deleted else "mode ")
                + ",".join(f"{entry[0] if entry else 0:06o}" for entry in old)
                + ("" if deleted else f"..{mode:06o}")
                + "\n"
            )
        if binary:
            out.append("Binary files differ\n")
            continue
        out.append(
            "--- "
            + (DEV_NULL if created else quote_path(f"a/{name}", False, fully))
            + "\n"
        )
        out.append(
            "+++ "
            + (DEV_NULL if deleted else quote_path(f"b/{name}", False, fully))
            + "\n"
        )
        out.extend(body)
    return encode_text("".join(out))


def text_lines(data: bytes) -> list[str]:
    """Split a blob at each newline only, the way git does, keeping them.

    Args:
        data (bytes): the blob's bytes.
    """
    *whole, rest = data.decode("utf-8", errors="replace").split("\n")
    return [line + "\n" for line in whole] + ([rest] if rest else [])


async def renames_enabled(
    dispatch: DispatchFn, location: RepoLocation
) -> bool:
    data = await read_optional(
        dispatch, join_spec(location.commondir, "config")
    )
    if data is None:
        return True
    cfg = ConfigFile.from_file(BytesIO(data))
    try:
        value = cfg.get((b"diff",), b"renames")
    except KeyError:
        return True
    return value.lower() not in (b"false", b"no", b"off", b"0", b"")


def separator_line(commit: Commit, kind: str, flags: DiffFlags) -> str | None:
    """The line git prints between a commit's text and its diff, None
    for none.

    ``---`` when both a diffstat and a patch follow, otherwise an empty
    line, and none under oneline, which is log-tree's rule. A combined
    diff (``-c``, ``--cc``) is printed from its own path, which always
    writes the empty line, oneline included. Pinned against git 2.50.1.

    Args:
        commit (Commit): the commit whose diff follows.
        kind (str): the pretty format's kind.
        flags (DiffFlags): the diff flags.
    """
    if len(commit.parents) > 1 and flags.merge in (
        "combined",
        "dense-combined",
    ):
        return ""
    if kind == "oneline":
        return None
    return "---" if flags.stat and flags.patch else ""


def join_output(
    commit: Commit,
    header: bytes,
    bodies: list[bytes | None],
    kind: str,
    width: int,
    flags: DiffFlags,
    empty_summary: bool = False,
) -> bytes:
    if not bodies:
        return header
    line = separator_line(commit, kind, flags)
    blocks = []
    for index, body in enumerate(bodies):
        if body is None:
            continue
        head = header
        if len(bodies) > 1 and kind not in ("format", "tformat"):
            parent = commit.parents[index].decode()
            full = commit.id.decode()
            if kind == "oneline":
                full, parent = full[:width], parent[:width]
            head = head.replace(
                full.encode(), f"{full} (from {parent})".encode(), 1
            )
        gap = (
            f"{line}\n".encode() if head and body and line is not None else b""
        )
        if not body and head and empty_summary:
            gap = b"\n"
        blocks.append(head + gap + body)
    separator = b"\n" if kind not in ("format", "tformat", "oneline") else b""
    return separator.join(blocks) or header
