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

from collections.abc import Iterable

from mirage.types import (
    HiddenPaths,
    HiddenVars,
    MountMode,
    PathSpec,
    ShowEntry,
    ShownPaths,
    Visibility,
    weaker_mode,
)
from mirage.utils.fnmatch import fnmatch

# The characters that make a document entry a pattern rather than an
# exact name; the permissions document has one grammar for every path
# list (design 3.6), and this is the whole classification rule.
GLOB_CHARS = frozenset("*?[")


def is_glob(entry: str) -> bool:
    """Whether a document entry is a pattern (any of ``*``, ``?``, ``[``).

    Args:
        entry (str): one entry of a ``hide`` list or a rule's ``paths``.
    """
    return any(ch in GLOB_CHARS for ch in entry)


def anchor_depth(entry: str) -> int:
    """How specific a path entry is: the number of literal components
    before its first wildcard.

    The one measure the permissions document's path axis orders by.
    ``/repo/sealed/*`` is 2, ``/repo/*`` and the plain subtree
    ``/repo`` are 1, and a slashless name pattern like ``*.key`` is 0,
    since it anchors nothing. Every pattern the document allows has an
    answer, so two entries about one path are always comparable and
    nothing is ever guessed.

    It lives here beside :func:`is_glob` rather than in the policy
    layer because both gates need it: admission scores the rule that
    covers an operand, and the entry gate scores the rule that covers
    an entry reached mid-walk.

    Args:
        entry (str): a path entry as written in the document.
    """
    depth = 0
    for part in entry.strip("/").split("/"):
        if not part or is_glob(part):
            break
        depth += 1
    return depth


def classify_paths(entries: Iterable[str]) -> HiddenPaths | None:
    """Compile document path entries into the matcher's shape.

    Glob = pattern, plain = exact subtree, in the order written; the
    same split serves ``paths.hide`` and a ``CommandRule``'s ``paths``
    so both planes match through :func:`path_hidden`. None when there
    is nothing to match, which is what "unrestricted" reads as.

    Args:
        entries (Iterable[str]): the document's entries.
    """
    listed = tuple(entries)
    paths = tuple(e for e in listed if not is_glob(e))
    patterns = tuple(e for e in listed if is_glob(e))
    if not paths and not patterns:
        return None
    return HiddenPaths(paths=paths, patterns=patterns)


def classify_vars(entries: Iterable[str]) -> HiddenVars | None:
    """Compile document variable entries into the matcher's shape.

    Glob = pattern over names, plain = exact name. None when empty.

    Args:
        entries (Iterable[str]): the document's ``vars.hide`` entries.
    """
    listed = tuple(entries)
    names = tuple(e for e in listed if not is_glob(e))
    patterns = tuple(e for e in listed if is_glob(e))
    if not names and not patterns:
        return None
    return HiddenVars(names=names, patterns=patterns)


def _norm_abs(path: str) -> str:
    """One absolute spelling for a path, no trailing slash.

    Args:
        path (str): a virtual path or hidden-spec entry.
    """
    stripped = path.strip("/")
    return "/" + stripped if stripped else "/"


def _matches_exact(entry: str, norm: str) -> bool:
    """Whether an exact entry covers this normalized path: the entry
    itself or anything in its subtree (prefix containment, no
    globbing).

    Args:
        entry (str): an exact entry as written.
        norm (str): the path, normalized by :func:`_norm_abs`.
    """
    p = _norm_abs(entry)
    return norm == p or norm.startswith(p + "/") or p == "/"


def _matches_component(pattern: str, parts: list[str]) -> bool:
    """Whether a slashless pattern hits any name component of the path,
    which covers the subtree below a matching directory for free.

    Args:
        pattern (str): a pattern with no ``/``.
        parts (list[str]): the path's components.
    """
    return any(fnmatch(seg, pattern) for seg in parts)


def _matches_anchored(pattern: str, parts: list[str]) -> bool:
    """Whether an anchored pattern matches the path or an ancestor of
    it, so a directory the pattern covers keeps its descendants
    covered. Patterns match with the repo fnmatch dialect, ``*``
    crossing slashes as GNU ``find -path`` does.

    Args:
        pattern (str): a pattern containing ``/``.
        parts (list[str]): the path's components.
    """
    norm_pat = _norm_abs(pattern)
    prefix = ""
    for seg in parts:
        prefix = f"{prefix}/{seg}"
        if fnmatch(prefix, norm_pat):
            return True
    return False


def hide_depth(hidden: HiddenPaths | None, virtual: str) -> int | None:
    """The deepest hide entry covering this virtual path, as its anchor
    depth; None when none does.

    Depth is a property of the entry, never of where it matched: an
    anchored pattern that covers a path through an ancestor still
    scores its own :func:`anchor_depth`, and a component pattern scores
    0 wherever it hits, since it anchors nothing.

    Args:
        hidden (HiddenPaths | None): the session's spec, None means
            unrestricted.
        virtual (str): absolute virtual path to test.
    """
    if hidden is None or (not hidden.paths and not hidden.patterns):
        return None
    norm = _norm_abs(virtual)
    parts = [seg for seg in norm.split("/") if seg]
    best: int | None = None
    for entry in hidden.paths:
        if _matches_exact(entry, norm):
            depth = anchor_depth(entry)
            if best is None or depth > best:
                best = depth
    for pat in hidden.patterns:
        if "/" in pat:
            if _matches_anchored(pat, parts):
                depth = anchor_depth(pat)
                if best is None or depth > best:
                    best = depth
        elif best is None and _matches_component(pat, parts):
            best = 0
    return best


def path_hidden(hidden: HiddenPaths | None, virtual: str) -> bool:
    """Whether the session's spec hides this virtual path, before any
    show entry is consulted: what a rule's paths match through, and the
    hide half of :func:`path_visible`.

    Args:
        hidden (HiddenPaths | None): the session's spec, None means
            unrestricted.
        virtual (str): absolute virtual path to test.
    """
    return hide_depth(hidden, virtual) is not None


def show_head(entry: str) -> str:
    """The place a show entry anchors to: the entry itself when exact,
    the fixed directory above its first glob segment when a pattern.

    Args:
        entry (str): a show entry's path as written.
    """
    return _pattern_head(entry) if is_glob(entry) else _norm_abs(entry)


def show_depth(shown: ShownPaths | None, virtual: str) -> int | None:
    """The deepest show entry covering this virtual path, as its anchor
    depth; None when none does.

    A show entry is always anchored (validation refuses a slashless
    pattern), so it covers its own subtree the way an exact hide does;
    a stray slashless pattern from a typed constructor covers nothing,
    failing toward refusal.

    Args:
        shown (ShownPaths | None): the session's show entries, None
            means the document states none.
        virtual (str): absolute virtual path to test.
    """
    if shown is None or not shown.entries:
        return None
    norm = _norm_abs(virtual)
    parts = [seg for seg in norm.split("/") if seg]
    best: int | None = None
    for entry in shown.entries:
        if is_glob(entry.path):
            if "/" not in entry.path or not _matches_anchored(
                entry.path, parts
            ):
                continue
        elif not _matches_exact(entry.path, norm):
            continue
        depth = anchor_depth(entry.path)
        if best is None or depth > best:
            best = depth
    return best


def path_visible(vis: Visibility | None, path: PathSpec) -> bool:
    """Whether one session's path axis leaves this virtual path
    visible: the whole composition law for the VFS axis.

    Three steps, each the anchor-depth rule: no hide covers the path
    and it is visible; a show covers it more deeply than the deepest
    hide and it is visible (hide wins the tie); and a hidden directory
    stays visible when a visible show anchors strictly below it, so the
    road to a carve-out exists (``hide /repo`` + ``show /repo/public``
    keeps ``/repo`` listable, holding only the carve-out).

    Args:
        vis (Visibility | None): the session's visibility, None for an
            unrestricted one.
        path (PathSpec): concrete workspace path to test.
    """
    virtual = path.virtual
    if vis is None:
        return True
    deepest_hide = hide_depth(vis.paths, virtual)
    if deepest_hide is None:
        return True
    shown = vis.shown
    deepest_show = show_depth(shown, virtual)
    if deepest_show is not None and deepest_show > deepest_hide:
        return True
    if shown is None:
        return False
    norm = _norm_abs(virtual)
    for entry in shown.entries:
        head = show_head(entry.path)
        if head == norm:
            # A globbed carve-out keeps its own anchor traversable: the
            # children `/repo/public/*` exposes score the anchor's
            # depth, so the anchor directory answers by the same
            # compare (an exact entry already answered through
            # show_depth above).
            if head != entry.path and anchor_depth(entry.path) > deepest_hide:
                return True
            continue
        if (norm == "/" or head.startswith(norm + "/")) and path_visible(
            vis, PathSpec.from_str_path(head)
        ):
            return True
    return False


def shown_mode(
    shown: ShownPaths | None, path: PathSpec
) -> tuple[int, MountMode] | None:
    """The deepest mode-carrying show entry covering this path, as
    (anchor depth, mode); None when none does.

    A list-form entry (mode None) states visibility only and never
    answers here. Two mode entries at one depth take the weaker,
    failing toward refusal.

    Args:
        shown (ShownPaths | None): the session's show entries.
        path (PathSpec): concrete workspace path to test.
    """
    if shown is None or not shown.entries:
        return None
    norm = _norm_abs(path.virtual)
    parts = [seg for seg in norm.split("/") if seg]
    best: tuple[int, MountMode] | None = None
    for entry in shown.entries:
        if entry.mode is None:
            continue
        if is_glob(entry.path):
            if "/" not in entry.path or not _matches_anchored(
                entry.path, parts
            ):
                continue
        elif not _matches_exact(entry.path, norm):
            continue
        depth = anchor_depth(entry.path)
        if best is None or depth > best[0]:
            best = (depth, entry.mode)
        elif depth == best[0]:
            best = (depth, weaker_mode(best[1], entry.mode))
    return best


def _pattern_head(pattern: str) -> str:
    """The fixed directory above an anchored pattern's first glob
    segment, normalized (``/x/locked/*`` -> ``/x/locked``).

    Args:
        pattern (str): an anchored pattern (one with a ``/``).
    """
    fixed: list[str] = []
    for seg in _norm_abs(pattern).split("/"):
        if is_glob(seg):
            break
        fixed.append(seg)
    return _norm_abs("/".join(fixed))


def path_covers(
    hidden: HiddenPaths | None, virtual: str, ancestors: bool = True
) -> bool:
    """Whether a spec has anything at or under this virtual path.

    Asked for an op that acts on a whole subtree (a rename of a
    directory, a recursive remove): ``/x/locked/*`` protects the
    children of ``/x/locked``, and moving or removing ``/x/locked`` or
    ``/x`` takes them along, so the op on the directory or an ancestor
    counts as touching the scope. Exact entries and the fixed head of
    an anchored pattern are tested; a component pattern (no ``/``)
    names no place, so only a walk could tell and it is not counted
    here. With ``ancestors`` False only the directory holding the
    scope counts, which is the question for a destination: moving
    into ``/x/locked`` lands in the scope, moving into ``/x`` does not.

    Args:
        hidden (HiddenPaths | None): the spec, None means unrestricted.
        virtual (str): absolute virtual path of the subtree op.
        ancestors (bool): whether an ancestor of the scope counts.
    """
    if hidden is None or (not hidden.paths and not hidden.patterns):
        return False
    norm = _norm_abs(virtual)
    heads = [_norm_abs(p) for p in hidden.paths]
    heads.extend(_pattern_head(p) for p in hidden.patterns if "/" in p)
    if any(head == norm for head in heads):
        return True
    return ancestors and any(
        norm == "/" or head.startswith(norm + "/") for head in heads
    )


def move_reveals(vis: Visibility | None, src: PathSpec, dst: PathSpec) -> bool:
    """Whether relocating ``src`` to ``dst`` could surface a hidden path.

    The reveal half of the subtree law: a session's mutation may destroy
    what it cannot see (``rm -r``, a remnant ``rmdir``), but may never
    reveal it, and a rename or a native directory copy is the relocation
    that would. Three arms, one per entry kind. A component pattern
    follows the name wherever the content goes, so it never reveals. An
    exact entry anchored strictly below ``src`` re-anchors to ``dst``
    plus its suffix, and reveals when the session would see that mapped
    path (a show anchored below the mapped path counts, through
    ``path_visible``'s own carve-out rule). An anchored pattern's
    coverage does not move with the content, so any pattern whose match
    space could reach below ``src`` refuses, failing toward refusal the
    way ``readonly_below`` blames a pattern.

    Spec-only: nothing here stats. A ``src`` that is a regular file has
    nothing below it to re-anchor, so the callers gate this check on the
    source being a directory (statting where they can, failing toward
    refusal where they cannot).

    Args:
        vis (Visibility | None): the session's visibility, None for an
            unrestricted one.
        src (PathSpec): path being moved or copied.
        dst (PathSpec): destination path.
    """
    hidden = vis.paths if vis is not None else None
    if hidden is None or (not hidden.paths and not hidden.patterns):
        return False
    s = _norm_abs(src.virtual)
    d = _norm_abs(dst.virtual)
    if s == "/":
        return True
    for entry in hidden.paths:
        e = _norm_abs(entry)
        if not e.startswith(s + "/"):
            continue
        mapped = ("" if d == "/" else d) + e[len(s) :]
        if path_visible(vis, PathSpec.from_str_path(mapped)):
            return True
    for pat in hidden.patterns:
        if "/" not in pat:
            continue
        head = _pattern_head(pat)
        if (
            head == s
            or head.startswith(s + "/")
            or head == "/"
            or s.startswith(head + "/")
        ):
            return True
    return False


def classify_shows(entries: Iterable[ShowEntry]) -> ShownPaths | None:
    """Compile document show entries into the session's shape.

    None when there is nothing, which is what "the document states no
    show" reads as, mirroring :func:`classify_paths`.

    Args:
        entries (Iterable[ShowEntry]): the compiled entries, in
            document order.
    """
    listed = tuple(entries)
    return ShownPaths(entries=listed) if listed else None


def hidden_under(vis: Visibility | None, path: PathSpec) -> bool:
    """Whether the session could hide anything at or under this path.

    The session form of :func:`hides_intersect`, for the view a native
    walk asks before it trusts the raw tree.

    Args:
        vis (Visibility | None): the session's visibility, None for an
            unrestricted one.
        path (PathSpec): the walk's starting path.
    """
    return hides_intersect(
        vis.paths if vis is not None else None, path.virtual
    )


def hides_intersect(hidden: HiddenPaths | None, virtual: str) -> bool:
    """Whether a spec could cover anything at or under this path.

    The per-operand gate for a native fast path: a backend's find op or
    du total classifies the raw tree, so it must not be trusted when a
    hide could cover an entry inside the subtree it answers for, and
    can stay on when none can (a hidden ``.env`` under ``/repo`` must
    not force ``find`` on ``/s3`` off its native op). A component
    pattern names no place, so it intersects everything; otherwise an
    entry intersects when its head lies at or under the path, or the
    path itself is inside the entry's subtree.

    Args:
        hidden (HiddenPaths | None): the spec (a session's hides or a
            rule's paths), None for none.
        virtual (str): absolute virtual path of the walk's start point.
    """
    if hidden is None or (not hidden.paths and not hidden.patterns):
        return False
    if any("/" not in p for p in hidden.patterns):
        return True
    if path_hidden(hidden, virtual) or path_covers(hidden, virtual):
        return True
    # An anchored pattern's wildcard tail can match anywhere below its
    # fixed head, so an operand at or under that head may hold matches
    # inside its subtree (`/repo/*/secret` against a walk of
    # `/repo/public`) even though the operand itself is neither hidden
    # nor an ancestor of the head.
    norm = _norm_abs(virtual)
    return any(
        head == "/" or norm.startswith(head + "/")
        for head in (_pattern_head(p) for p in hidden.patterns if "/" in p)
    )


def var_hidden(vis: Visibility | None, name: str) -> bool:
    """Whether the session hides this variable name.

    Args:
        vis (Visibility | None): the session's visibility, None for an
            unrestricted one.
        name (str): variable name to test.
    """
    hidden = vis.vars if vis is not None else None
    if hidden is None:
        return False
    if name in hidden.names:
        return True
    for pat in hidden.patterns:
        if fnmatch(name, pat):
            return True
    return False
