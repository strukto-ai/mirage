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
import fnmatch
import logging
import posixpath
from collections.abc import Callable

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.types import PathSpec
from mirage.utils.key_prefix import rekey

logger = logging.getLogger(__name__)

GLOB_CHARS = ("*", "?", "[")


def has_glob(segment: str) -> bool:
    """Whether a path segment contains shell glob characters.

    Args:
        segment (str): one path component.
    """
    return any(ch in segment for ch in GLOB_CHARS)


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
    readdir: Callable,
    accessor: Accessor,
    path: PathSpec,
    index: IndexCacheStore | None,
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
        index (IndexCacheStore | None): the per-call cache index.
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
    base = (prefix + "/".join(segments[:first])).rstrip("/") or "/"
    level = [base]
    for seg in segments[first:]:
        next_level: list[str] = []
        for parent in level:
            spec = PathSpec.from_str_path(
                parent, rekey(path.virtual, path.resource_path, parent))
            try:
                entries = await readdir(accessor, spec, index)
            except (FileNotFoundError, NotADirectoryError):
                continue
            next_level.extend(
                e for e in entries
                if fnmatch.fnmatch(e.rstrip("/").rsplit("/", 1)[-1], seg))
        level = next_level
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
    return [
        dataclasses.replace(m,
                            raw_path=spell_match(path.raw_path, m.virtual,
                                                 walked)) for m in matches
    ]


async def resolve_glob_with(
    readdir: Callable,
    accessor: Accessor,
    paths: list[PathSpec],
    index: IndexCacheStore | None,
    cap: int | None = None,
) -> list[PathSpec]:
    """Shared resolve_glob loop over a backend's readdir.

    Resolved specs pass through, pattern specs expand segment-by-segment
    via :func:`expand_pattern` (mid-path aware, spelled as typed), an
    unmatched glob word stays the literal (bash with nullglob off: the
    command then errors on it like GNU), and matches cap at ``cap`` when
    given. Per-backend glob modules bind their own readdir.

    Args:
        readdir (Callable): backend readdir ``(accessor, path, index)``
            returning absolute virtual paths.
        accessor (Accessor): backend handle passed through to readdir.
        paths (list[PathSpec]): specs to resolve.
        index (IndexCacheStore | None): the per-call cache index.
        cap (int | None): cap on matches per pattern before truncation.
    """
    result: list[PathSpec] = []
    for p in paths:
        if isinstance(p, str):
            result.append(
                PathSpec(virtual=p,
                         directory=posixpath.dirname(p),
                         resource_path=p.strip("/")))
            continue
        if p.resolved:
            result.append(p)
        elif p.pattern:
            matched = await expand_pattern(readdir, accessor, p, index)
            if not matched and is_word_shaped(p):
                # bash with nullglob off: an unmatched glob word stays
                # the literal; the command then errors on it like GNU
                # (cat '*.nope' -> No such file or directory, exit 1).
                # Dir-shaped specs (PathSpec.dir) are internal
                # expansions and keep the empty result.
                result.append(
                    dataclasses.replace(p, pattern=None, resolved=True))
                continue
            if cap is not None and len(matched) > cap:
                logger.warning("%s: %d matches exceeds limit (%d), truncating",
                               p.directory, len(matched), cap)
                matched = matched[:cap]
            result.extend(matched)
        else:
            result.append(p)
    return result
