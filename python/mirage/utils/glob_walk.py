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

import dataclasses
import logging
from collections.abc import Awaitable, Callable, Sequence
from datetime import date, timedelta
from typing import Any, Protocol

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.context import dotglob_active, path_allowed
from mirage.ops.types import ChildMounts, LinkTargetStat
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import WALK_ERRORS
from mirage.utils.fnmatch import fnmatch
from mirage.utils.key_prefix import rekey

logger = logging.getLogger(__name__)

GLOB_CHARS = ("*", "?", "[")


def _meta_index(pattern: str) -> int:
    first = -1
    for ch in GLOB_CHARS:
        idx = pattern.find(ch)
        if idx != -1 and (first == -1 or idx < first):
            first = idx
    return first


def has_glob_span(pattern: str) -> bool:
    """Whether a glob names a date range a windowed lister can move to.

    The kit's ``pattern_kinds`` table holds one of these per kind: a glob
    it answers True for reaches the lister and bypasses the index, and
    any other glob is filtered out of the ordinary cached listing.

    Args:
        pattern (str): the glob as typed.
    """
    return glob_span(pattern) is not None


def has_glob_prefix(pattern: str) -> bool:
    """Whether a glob starts with literal text a query can narrow on.

    The ``pattern_kinds`` twin of ``has_glob_span`` for a backend whose
    window is a row cap rather than a date range: the literal prefix
    becomes a prefix match in the query, so the cap covers the region
    the line named instead of the head of the table.

    Args:
        pattern (str): the glob as typed.
    """
    return bool(glob_prefix(pattern))


def glob_prefix(pattern: str | None) -> str:
    """The literal text a glob starts with, before its first metacharacter.

    A quoted glob character travels under a private mark and stands for
    that character literally, so the marks are restored here: `'*'ab*`
    asks for names starting with a real star.

    Args:
        pattern (str | None): the glob as typed, or None.

    Returns:
        str: the literal prefix, empty when the glob opens with a
        metacharacter or carries none at all.
    """
    if not pattern:
        return ""
    meta_index = _meta_index(pattern)
    if meta_index == -1:
        return ""
    return unmark_globs(pattern[:meta_index])


def glob_stem_prefix(pattern: str | None, suffixes: Sequence[str]) -> str:
    """The literal prefix a glob puts on the stem of a leaf name.

    A leaf is a stem plus one of the renderer's suffixes, so a literal
    that has run into a suffix says nothing about the stem and the part
    that ran in is dropped: `12*.md` narrows to `12`, and `doc-1.m*`
    narrows to `doc-1` rather than asking for stems that start
    `doc-1.m`. Only a tail that spells the head of a suffix is dropped,
    which is what keeps a stem that contains a dot: `acct.2026*` narrows
    to `acct.2026`, where cutting at the first dot would narrow to
    `acct` and let the rows nobody asked for eat the window.

    Args:
        pattern (str | None): the glob as typed, or None.
        suffixes (Sequence[str]): the suffixes a leaf name can carry.

    Returns:
        str: the literal stem prefix, empty when there is none.
    """
    literal = glob_prefix(pattern)
    reached = 0
    for suffix in suffixes:
        for size in range(1, len(suffix) + 1):
            if literal.endswith(suffix[:size]):
                reached = max(reached, size)
    return literal[:len(literal) - reached]


def glob_span(pattern: str | None) -> tuple[date, date] | None:
    """The half-open range of dates a date-prefixed glob asks for.

    The literal prefix before the first metacharacter is read as a year,
    a month or a day, so ``2026-*`` spans a year and ``2026-01-05*`` one
    day. This is what lets a windowed listing honour a glob instead of
    filtering its own window: the backend moves the window to the span
    the line named.

    Args:
        pattern (str | None): the glob as typed, or None.

    Returns:
        tuple[date, date] | None: (start, end) with end exclusive, or
        None when the glob does not start with a date prefix.
    """
    literal = glob_prefix(pattern)
    if not literal:
        return None
    parts = literal.rstrip("_-").split("-")
    try:
        if len(parts) == 1 and len(parts[0]) == 4:
            year = int(parts[0])
            return date(year, 1, 1), date(year + 1, 1, 1)
        if len(parts) == 2 and len(parts[0]) == 4 and len(parts[1]) == 2:
            year, month = int(parts[0]), int(parts[1])
            start = date(year, month, 1)
            if month == 12:
                return start, date(year + 1, 1, 1)
            return start, date(year, month + 1, 1)
        if (len(parts) == 3 and len(parts[0]) == 4 and len(parts[1]) == 2
                and len(parts[2]) == 2):
            start = date(int(parts[0]), int(parts[1]), int(parts[2]))
            return start, start + timedelta(days=1)
    except ValueError:
        return None
    return None


# A quoted glob character keeps travelling as a character, under a
# private mark, because bash tracks quoting per character and not per
# word: `'*'?.txt` still globs, on the `?` alone, and matches only a
# name starting with a literal star. A mark is one character wide, so
# every length relation between a spec's virtual, directory,
# vfs_path and raw_path keeps holding, and no mark is a glob
# character, so `has_glob` already answers "does this word still glob".
# The marks are Unicode noncharacters, permanently unassigned and never
# valid interchange text -- the same impossible input `brace.py` assumes
# away when it delimits its inert atoms with NUL.
_GLOB_MARKS = {"*": "\ufdd0", "?": "\ufdd1", "[": "\ufdd2"}
_GLOB_CHAR_OF = {mark: ch for ch, mark in _GLOB_MARKS.items()}
# Translation tables, not per-character loops: every expanded word is
# marked and unmarked, so a Python-level rebuild made the cost quadratic
# in a loop that grows one word (`while true; do export X=$X.; done`).
_MARK_TABLE = str.maketrans(_GLOB_MARKS)
_UNMARK_TABLE = str.maketrans(_GLOB_CHAR_OF)
_PATTERN_TABLE = str.maketrans({
    mark: f"[{ch}]"
    for mark, ch in _GLOB_CHAR_OF.items()
})

DEFAULT_MAX_GLOB_MATCHES = 10000


def has_glob(segment: str) -> bool:
    """Whether a path segment contains shell glob characters.

    Args:
        segment (str): one path component.
    """
    return any(ch in segment for ch in GLOB_CHARS)


def mark_globs(text: str) -> str:
    """Quote every glob character, the way enclosing quotes would.

    Args:
        text (str): text whose glob characters are literal.
    """
    return text.translate(_MARK_TABLE)


def unmark_globs(text: str) -> str:
    """The literal spelling: every quoted glob character as itself.

    Args:
        text (str): text that may carry glob marks.
    """
    return text.translate(_UNMARK_TABLE)


def mark_escaped_globs(text: str) -> str:
    """Mark the glob characters a backslash quotes in raw word text.

    Read the way bash reads an unquoted word: ``\\*`` is a quoted star
    and ``\\\\*`` is a literal backslash followed by a live star. The
    backslash is left in place for the quote-removal pass that follows,
    which drops it and leaves the mark behind.

    Args:
        text (str): a word's raw source text, escapes intact.
    """
    if "\\" not in text:
        return text
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\\" and i + 1 < n:
            out.append(ch)
            out.append(_GLOB_MARKS.get(text[i + 1], text[i + 1]))
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def glob_pattern(segment: str) -> str:
    """A marked segment as the pattern fnmatch has to see.

    fnmatch has no escape character, so a quoted glob character is
    handed over as its own one-character class, exactly what
    :func:`escape_glob` builds for text that is literal throughout.

    Args:
        segment (str): one path component, marks intact.
    """
    return segment.translate(_PATTERN_TABLE)


def _unmark_spec(spec: PathSpec) -> PathSpec:
    """Drop the marks from a spec, leaving the literal path it names.

    Args:
        spec (PathSpec): a spec built from a marked word.
    """
    return dataclasses.replace(
        spec,
        virtual=unmark_globs(spec.virtual),
        directory=unmark_globs(spec.directory),
        vfs_path=unmark_globs(spec.vfs_path),
        raw_path=unmark_globs(spec.raw_path),
        pattern=None if spec.pattern is None else unmark_globs(spec.pattern),
    )


def _has_glob_marks(text: str) -> bool:
    """Whether text still carries a glob character quoting made literal.

    Args:
        text (str): any expanded text.
    """
    return any(mark in text for mark in _GLOB_CHAR_OF)


def literal_word(item: "str | PathSpec") -> "str | PathSpec":
    """The word after quote removal, once glob resolution is over.

    The marks come off here, and a word still carrying a pattern is
    frozen as its literal: that pattern outlived its marks (an unmatched
    glob, ``set -f``, a backend that could not resolve it), and reading
    the unmarked text as a pattern again would let a quoted
    metacharacter match -- ``rm '/data/*'?.txt`` would be back to
    reaching every name the live ``?`` alone would. A word that carried
    no marks is returned untouched.

    Args:
        item (str | PathSpec): one resolved word.
    """
    if isinstance(item, str):
        return unmark_globs(item)
    if not (_has_glob_marks(item.virtual)
            or _has_glob_marks(item.pattern or "")):
        return item
    spec = _unmark_spec(item)
    if spec.pattern is None:
        return spec
    return dataclasses.replace(spec, pattern=None, resolved=True)


def escape_glob(text: str) -> str:
    """Encode text so the glob matcher reads every character literally.

    fnmatch has no escape character, so each special is wrapped in its
    own one-character class: ``*`` becomes ``[*]``. A ``]`` needs no
    treatment: outside a class it is already literal, and no class can
    open because every ``[`` gets wrapped.

    Args:
        text (str): literal text destined for a glob pattern.
    """
    return "".join(f"[{c}]" if c in GLOB_CHARS else c for c in text)


def is_word_shaped(p: PathSpec) -> bool:
    """Whether a pattern spec is a typed word (not a directory listing).

    A classify-shaped word puts the pattern inside ``virtual``
    (``/data/s*/x.txt`` with directory ``/data/s*/``); a dir-shaped spec
    (``PathSpec.dir``) sets ``virtual`` to the directory itself.

    Args:
        p (PathSpec): unresolved pattern spec.
    """
    return p.virtual.rstrip("/") != p.directory.rstrip("/")


def spell_match(raw: str, virtual: str, walked: int) -> str:
    """Spell a match the way bash expansion would.

    Bash rewrites only the glob segments of the typed word; everything
    before the first glob segment keeps its typed spelling, so
    ``../s*/x.txt`` expands to ``../sub/x.txt``. The walked tail has the
    same segment count in the typed word and in the match's virtual
    path, so the spelling is the typed head plus the match's last
    ``walked`` segments.

    Args:
        raw (str): the pattern word as typed (``PathSpec.raw_path``).
        virtual (str): one match's absolute virtual path.
        walked (int): segment count from the first glob segment on.
    """
    head = raw.rstrip("/").split("/")[:-walked]
    tail = virtual.rstrip("/").split("/")[-walked:]
    return "/".join([*head, *tail])


def glob_name_matches(name: str, pattern: str) -> bool:
    """Whether one directory entry answers a pathname-expansion segment.

    `fnmatch` plus bash's leading-dot rule: a name that starts with `.`
    is matched only by a pattern that starts with `.` (so `*`, `?h` and
    `[.]h` all pass over `.h`), unless the session has `shopt -s
    dotglob`. This is pathname expansion's rule alone; `find -name` and
    `case` patterns match through `fnmatch` directly, and GNU agrees
    that `find -name '*'` sees dotfiles.

    Args:
        name (str): the entry's own name, no directory part.
        pattern (str): the segment, marks already resolved.
    """
    if name.startswith(
            ".") and not pattern.startswith(".") and not dotglob_active():
        return False
    return fnmatch(name, pattern)


async def expand_pattern(
    readdir: Callable[..., Any],
    accessor: Accessor,
    path: PathSpec,
    index: IndexCacheStore,
    children: ChildMounts | None = None,
) -> list[PathSpec]:
    """Expand a glob PathSpec segment-by-segment via readdir.

    Mirrors bash globbing: every path component containing a glob
    character is matched against the entries of its (already expanded)
    parent directory, so a mid-path pattern (``pages/Demo_*/page.md``)
    never reaches the backend as a literal ``*`` path segment. An
    intermediate match that cannot be listed (a file, or a vanished
    entry) is skipped, matching bash's directories-only descent for
    non-final components.

    Args:
        readdir (Callable): backend readdir ``(accessor, path, index)``
            returning absolute virtual paths.
        accessor (Accessor): backend handle passed through to readdir.
        path (PathSpec): unresolved spec whose ``vfs_path`` still
            contains the pattern.
        index (IndexCacheStore): the per-call cache index.
        children (ChildMounts | None): child names the namespace owes a
            directory (nested mount roots and symlinks). No backend can
            see either, so a walk that stops at readdir misses both; this
            is the union ``merge_readdir`` applies to a listing.
    """
    prefix = path.virtual[:len(path.virtual.rstrip("/")) - len(path.vfs_path)]
    segments = path.vfs_path.split("/") if path.vfs_path else []
    # Two spec shapes reach resolvers: a full pattern path (classify), where
    # the pattern is already the last segment, and a directory-shaped spec
    # (PathSpec.dir), where the pattern applies to the directory's entries.
    if path.pattern and (not segments or segments[-1] != path.pattern):
        segments = [*segments, path.pattern]
    first = next((i for i, seg in enumerate(segments) if has_glob(seg)),
                 len(segments) - 1)
    # The head above the first glob segment is a real directory, so a
    # glob character quoted inside it is part of the name to list.
    base = unmark_globs((prefix + "/".join(segments[:first])).rstrip("/")
                        or "/")
    level = [base]
    for seg in segments[first:]:
        next_level: list[str] = []
        for parent in level:
            # Directory-shaped, carrying the segment as the pattern: a
            # backend whose listing for this level is a bounded window
            # moves the window to what the glob asks for instead of
            # filtering its own (gcal, gdocs and the dated-message
            # channels). Every other readdir reads the directory off the
            # same spec and ignores the field. A literal segment carries
            # none, so it keeps its warm listing.
            spec = PathSpec(virtual=parent,
                            directory=parent,
                            vfs_path=rekey(path.virtual, path.vfs_path,
                                           parent),
                            pattern=seg if has_glob(seg) else None)
            try:
                entries = await readdir(accessor, spec, index)
            except (FileNotFoundError, NotADirectoryError):
                entries = []
            pattern = glob_pattern(seg)
            # A cold listing marks a folder with a trailing slash (box,
            # gdrive, dropbox); the marker is not part of the name.
            for e in entries:
                entry = e.rstrip("/")
                if glob_name_matches(entry.rsplit("/", 1)[-1], pattern):
                    next_level.append(entry)
            if children is not None:
                # A nested mount root or a link is a real child of this
                # parent whether or not the backend could list it.
                base_dir = parent.rstrip("/")
                next_level.extend(f"{base_dir}/{name}"
                                  for name in children(f"{base_dir}/")
                                  if glob_name_matches(name, pattern))
        # bash sorts a pathname expansion, and the two sources are
        # enumerated separately, so the union is ordered here.
        level = sorted(set(next_level))
        if not level:
            return []
    matches = [
        PathSpec.from_str_path(e, rekey(path.virtual, path.vfs_path, e))
        for e in level
    ]
    # A typed word (raw differs from virtual) spells its matches; the
    # dir-shaped specs internal expansions build (PathSpec.dir) have no
    # typed form and keep the resolved virtual.
    if path.raw_path == path.virtual:
        return matches
    walked = len(segments) - first
    raw = unmark_globs(path.raw_path)
    return [
        dataclasses.replace(m, raw_path=spell_match(raw, m.virtual, walked))
        for m in matches
    ]


class ResolveGlobFn(Protocol):
    """One backend's glob resolver, bound to its own readdir.

    Named rather than left as `Callable[..., Any]`, because that erasure
    is what let the VFS base declare a wider parameter than any
    implementation accepts. `ResolveGlobOp` in the generic_bind adapter
    is the consumer-side twin; mypy checks the two agree where the
    adapter hands this function out, which is the check that was missing.
    """

    def __call__(self,
                 accessor: Any,
                 paths: Sequence[PathSpec],
                 /,
                 index: IndexCacheStore = ...) -> Awaitable[list[PathSpec]]:
        ...


def make_resolve_glob(
    readdir: Callable[..., Any],
    max_glob_matches: int | None = DEFAULT_MAX_GLOB_MATCHES,
    children: ChildMounts | None = None,
    stat: Callable[..., Any] | None = None,
    target_stat: LinkTargetStat | None = None,
) -> ResolveGlobFn:
    """Build a resolve_glob generic over a backend's readdir.

    Args:
        readdir (Callable): backend readdir ``(accessor, path, index)``.
        max_glob_matches (int | None): cap on matches per pattern before
            truncation.
        children (ChildMounts | None): child names the namespace owes a
            directory, so an expansion sees nested mount roots and links.
        stat (Callable | None): backend stat ``(accessor, path, index)``,
            which is what lets a trailing slash keep directories only.
        target_stat (LinkTargetStat | None): the namespace's stat of what
            an owed name points at, resolved through the workspace, so a
            trailing slash can follow a link the way bash does.
    """

    async def resolve_glob(
        accessor: Accessor,
        paths: Sequence[PathSpec],
        /,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[PathSpec]:
        return await resolve_glob_with(readdir, accessor, paths, index,
                                       max_glob_matches, children, stat,
                                       target_stat)

    return resolve_glob


async def _is_directory(stat: Callable[..., Any] | None, accessor: Accessor,
                        match: PathSpec, index: IndexCacheStore,
                        children: ChildMounts | None,
                        target_stat: LinkTargetStat | None) -> bool:
    """Whether a match is a directory, the way a trailing slash asks.

    A name the namespace owes the directory (a nested mount root or a
    link) is no backend's to stat: the namespace answers for it through
    ``target_stat``, which follows a link and stats what it reaches, so
    a link to a directory is kept and a link to a file or to nothing is
    dropped, bash's own rule for ``*/``. Without that door the owed name
    is kept, and without a stat door every match is kept, since nothing
    can tell them apart. Otherwise one stat per match, served from the
    index the readdir just filled.

    Args:
        stat (Callable | None): backend stat ``(accessor, path, index)``.
        accessor (Accessor): backend handle passed through to stat.
        match (PathSpec): one match.
        index (IndexCacheStore): the per-call cache index.
        children (ChildMounts | None): child names the namespace owes a
            directory.
        target_stat (LinkTargetStat | None): the namespace's stat of
            what an owed name points at, None when it dangles.
    """
    if stat is None:
        return True
    parent = match.virtual.rstrip("/").rsplit("/", 1)[0] + "/"
    name = match.virtual.rstrip("/").rsplit("/", 1)[-1]
    if children is not None and name in children(parent):
        if target_stat is None:
            return True
        row = await target_stat(match.virtual.rstrip("/"))
        return row is not None and row.type == FileType.DIRECTORY
    try:
        row = await stat(accessor, match, index=index)
    except WALK_ERRORS:
        return False
    return isinstance(row, FileStat) and row.type == FileType.DIRECTORY


async def resolve_glob_with(
    readdir: Callable[..., Any],
    accessor: Accessor,
    paths: Sequence[PathSpec],
    index: IndexCacheStore,
    cap: int | None = None,
    children: ChildMounts | None = None,
    stat: Callable[..., Any] | None = None,
    target_stat: LinkTargetStat | None = None,
) -> list[PathSpec]:
    """Shared resolve_glob loop over a backend's readdir.

    Resolved specs pass through, pattern specs expand segment-by-segment
    via :func:`expand_pattern` (mid-path aware, spelled as typed), an
    unmatched glob word stays the literal (bash with nullglob off: the
    command then errors on it like GNU), and matches cap at ``cap`` when
    given. Per-backend glob modules bind their own readdir.

    The spec shape is how a caller chooses between the two answers, and
    the choice matters because the literal is not distinguishable from a
    match by looking at it: a file may be named exactly like the word
    that globbed for it. A word-shaped spec asks for bash's own answer,
    literal included. A directory-shaped spec (``PathSpec.dir``) asks for
    matches alone, so an empty list means nothing matched -- what a
    caller merging these matches with another source needs, since only it
    can tell whether the union is empty.

    Args:
        readdir (Callable): backend readdir ``(accessor, path, index)``
            returning absolute virtual paths.
        accessor (Accessor): backend handle passed through to readdir.
        paths (Sequence[PathSpec]): specs to resolve.
        index (IndexCacheStore): the per-call cache index.
        cap (int | None): cap on matches per pattern before truncation.
        children (ChildMounts | None): child names the namespace owes a
            directory, so an expansion sees nested mount roots and links.
        stat (Callable | None): backend stat ``(accessor, path, index)``;
            without it a trailing slash cannot drop the files it matched.
        target_stat (LinkTargetStat | None): the namespace's stat of what
            an owed name (a link, a nested mount root) points at; without
            it a trailing slash keeps every owed name.
    """
    result: list[PathSpec] = []
    for p in paths:
        if p.resolved:
            result.append(p)
        elif p.pattern:
            # A trailing slash asks for directories only, and every match
            # keeps one (`*/` -> `sub/`), the same rule the shell tier
            # applies in workspace/expand/globs.py. The slash is not part
            # of the spelling to rebuild, so it comes off the word here
            # and goes back on each match; the literal answer to a
            # zero-match glob is still the word as typed (#1065).
            dirs_only = p.raw_path.endswith("/") and p.raw_path != p.virtual
            word = (dataclasses.replace(p, raw_path=p.raw_path.rstrip("/"))
                    if dirs_only else p)
            # The hidden filter sits here, in the one loop every backend's
            # resolve_glob runs through, because per-backend glob modules
            # bind raw readdirs that never pass the command-door guard. It
            # runs before the empty-match test so an all-hidden match set
            # reads as no matches and falls back to the literal word,
            # exactly what bash prints when nothing matched.
            matched = [
                m for m in await expand_pattern(readdir, accessor, word, index,
                                                children)
                if path_allowed(m.virtual)
            ]
            if dirs_only:
                kept: list[PathSpec] = []
                for m in matched:
                    if await _is_directory(stat, accessor, m, index, children,
                                           target_stat):
                        kept.append(
                            dataclasses.replace(m, raw_path=m.raw_path + "/"))
                matched = kept
            if not matched and is_word_shaped(p):
                # bash with nullglob off: an unmatched glob word stays
                # the literal; the command then errors on it like GNU
                # (cat '*.nope' -> No such file or directory, exit 1).
                # The literal is the word after quote removal, so the
                # marks come off here. Dir-shaped specs (PathSpec.dir)
                # keep the empty result, which is what a caller that has
                # to merge these matches with another source asks for.
                result.append(
                    _unmark_spec(
                        dataclasses.replace(p, pattern=None, resolved=True)))
                continue
            if cap is not None and len(matched) > cap:
                logger.warning("%s: %d matches exceeds limit (%d), truncating",
                               unmark_globs(p.directory), len(matched), cap)
                matched = matched[:cap]
            result.extend(matched)
        else:
            result.append(p)
    return result
