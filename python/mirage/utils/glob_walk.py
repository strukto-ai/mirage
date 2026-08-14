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
from collections.abc import Callable
from typing import Any

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.context import path_allowed
from mirage.ops.types import ChildMounts
from mirage.types import PathSpec
from mirage.utils.fnmatch import fnmatch
from mirage.utils.key_prefix import rekey

logger = logging.getLogger(__name__)

GLOB_CHARS = ("*", "?", "[")

# A quoted glob character keeps travelling as a character, under a
# private mark, because bash tracks quoting per character and not per
# word: `'*'?.txt` still globs, on the `?` alone, and matches only a
# name starting with a literal star. A mark is one character wide, so
# every length relation between a spec's virtual, directory,
# resource_path and raw_path keeps holding, and no mark is a glob
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
        resource_path=unmark_globs(spec.resource_path),
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
        path (PathSpec): unresolved spec whose ``resource_path`` still
            contains the pattern.
        index (IndexCacheStore): the per-call cache index.
        children (ChildMounts | None): child names the namespace owes a
            directory (nested mount roots and symlinks). No backend can
            see either, so a walk that stops at readdir misses both; this
            is the union ``merge_readdir`` applies to a listing.
    """
    prefix = path.virtual[:len(path.virtual.rstrip("/")) -
                          len(path.resource_path)]
    segments = path.resource_path.split("/") if path.resource_path else []
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
            spec = PathSpec.from_str_path(
                parent, rekey(path.virtual, path.resource_path, parent))
            try:
                entries = await readdir(accessor, spec, index)
            except (FileNotFoundError, NotADirectoryError):
                entries = []
            pattern = glob_pattern(seg)
            next_level.extend(
                e for e in entries
                if fnmatch(e.rstrip("/").rsplit("/", 1)[-1], pattern))
            if children is not None:
                # A nested mount root or a link is a real child of this
                # parent whether or not the backend could list it.
                base_dir = parent.rstrip("/")
                next_level.extend(f"{base_dir}/{name}"
                                  for name in children(f"{base_dir}/")
                                  if fnmatch(name, pattern))
        # bash sorts a pathname expansion, and the two sources are
        # enumerated separately, so the union is ordered here.
        level = sorted(set(next_level))
        if not level:
            return []
    matches = [
        PathSpec.from_str_path(e, rekey(path.virtual, path.resource_path, e))
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


def make_resolve_glob(
    readdir: Callable[..., Any],
    max_glob_matches: int | None = DEFAULT_MAX_GLOB_MATCHES,
    children: ChildMounts | None = None,
) -> Callable[..., Any]:
    """Build a resolve_glob generic over a backend's readdir.

    Args:
        readdir (Callable): backend readdir ``(accessor, path, index)``.
        max_glob_matches (int | None): cap on matches per pattern before
            truncation.
        children (ChildMounts | None): child names the namespace owes a
            directory, so an expansion sees nested mount roots and links.
    """

    async def resolve_glob(
        accessor: Accessor,
        paths: list[PathSpec],
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[PathSpec]:
        return await resolve_glob_with(readdir, accessor, paths, index,
                                       max_glob_matches, children)

    return resolve_glob


async def resolve_glob_with(
    readdir: Callable[..., Any],
    accessor: Accessor,
    paths: list[PathSpec],
    index: IndexCacheStore,
    cap: int | None = None,
    children: ChildMounts | None = None,
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
        paths (list[PathSpec]): specs to resolve.
        index (IndexCacheStore): the per-call cache index.
        cap (int | None): cap on matches per pattern before truncation.
        children (ChildMounts | None): child names the namespace owes a
            directory, so an expansion sees nested mount roots and links.
    """
    result: list[PathSpec] = []
    for p in paths:
        if p.resolved:
            result.append(p)
        elif p.pattern:
            # The hidden filter sits here, in the one loop every backend's
            # resolve_glob runs through, because per-backend glob modules
            # bind raw readdirs that never pass the command-door guard. It
            # runs before the empty-match test so an all-hidden match set
            # reads as no matches and falls back to the literal word,
            # exactly what bash prints when nothing matched.
            matched = [
                m for m in await expand_pattern(readdir, accessor, p, index,
                                                children)
                if path_allowed(m.virtual)
            ]
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
