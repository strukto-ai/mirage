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

from mirage.ops.config import NamespaceLinks
from mirage.ops.namespace_view import child_mount_names, namespace_names
from mirage.shell.constants import SHOPT_DEFAULTS
from mirage.shell.errors import ExitSignal
from mirage.types import PathSpec
from mirage.utils.glob_walk import (glob_name_matches, glob_pattern, has_glob,
                                    literal_word, spell_match, unmark_globs)
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import CycleError
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.session import Session

# How deep a `**` descends. bash has no cap, but every level here is one
# listing per directory, so an accidental `**` over a large tree is
# bounded rather than open-ended.
GLOBSTAR_MAX_DEPTH = 32


@dataclasses.dataclass(frozen=True, slots=True)
class GlobOptions:
    """The `shopt` options pathname expansion reads.

    `dotglob` is deliberately absent: it is applied inside every
    backend's `resolve_glob` (`glob_name_matches`), which reads it from
    the bound session, so it does not have to travel with the word.

    Args:
        nullglob (bool): a glob that matches nothing expands to nothing.
        failglob (bool): a glob that matches nothing is a fatal
            expansion error, `bash: no match: WORD`.
        globstar (bool): a `**` segment matches zero or more directory
            levels instead of reading as `*`.
    """
    nullglob: bool = False
    failglob: bool = False
    globstar: bool = False

    @property
    def needs_shell(self) -> bool:
        """Whether a mount command's glob has to expand here rather than
        be pushed down to the backend, which knows none of these."""
        return self.nullglob or self.failglob or self.globstar


def glob_options(session: Session) -> GlobOptions:
    """The session's pathname-expansion options.

    Args:
        session (Session): the session holding the `shopt` table.
    """
    return GlobOptions(nullglob=session.shopts.get("nullglob",
                                                   SHOPT_DEFAULTS["nullglob"]),
                       failglob=session.shopts.get("failglob",
                                                   SHOPT_DEFAULTS["failglob"]),
                       globstar=session.shopts.get("globstar",
                                                   SHOPT_DEFAULTS["globstar"]))


def _namespace_children(registry: MountRegistry, links: NamespaceLinks | None,
                        directory: str, pattern: str) -> list[str]:
    """Virtual paths a directory owes the namespace, matching a segment.

    Child mounts and symlinks are namespace state no backend can see, so
    a glob that stops at one backend misses both: a nested mount's keys
    live in another resource, and no resource stores a link. This is the
    union ``merge_readdir`` already applies to a listing, filtered by the
    glob segment with the same matcher backends use, and session-filtered
    by ``namespace_names`` so a scoped session never learns an ungranted
    mount's name from an expansion.

    Args:
        registry (MountRegistry): registry holding the mount table.
        links (NamespaceLinks | None): the namespace symlink table.
        directory (str): the directory being globbed.
        pattern (str): the glob segment matched against child names.
    """
    base = directory.rstrip("/")
    matcher = glob_pattern(pattern)
    return [
        f"{base}/{name}" for name in namespace_names(
            [m.prefix for m in registry.mounts()], links, directory)
        if glob_name_matches(name, matcher)
    ]


def _as_spec(match: str | PathSpec, prefix: str) -> PathSpec:
    """Normalize one backend match to a PathSpec.

    Args:
        match (str | PathSpec): one match as the backend reported it.
        prefix (str): the mount prefix with no trailing slash.
    """
    if isinstance(match, PathSpec):
        return match
    full = match if match.startswith(prefix) else prefix + match
    return PathSpec.from_str_path(full, mount_key(full, prefix))


def _merge_namespace(matches: list[str | PathSpec], extra: list[str],
                     directory: str, prefix: str, registry: MountRegistry,
                     mount: MountEntry) -> list[PathSpec]:
    """Union a backend's matches with the namespace-owed ones.

    Sorted, because bash sorts a pathname expansion and the two sources
    are enumerated separately. The backend is asked with a
    directory-shaped spec, which answers with matches alone, so "nothing
    matched" arrives as an empty list and the caller reinstates the
    literal only when the union is empty too.

    A match is a child of the directory it was globbed in, so a spec that
    is the directory itself is not one. The shared resolver never answers
    a dir-shaped ask that way, but ``resolve_glob`` is a public hook and a
    resource reinstating the literal on its own would hand back the spec
    it was given. Unlike the word comparison this replaces, the test
    cannot discard a real match: a match is strictly longer than the
    directory holding it, while a word can be spelled exactly like one.

    Args:
        matches (list[str | PathSpec]): the backend's own matches.
        extra (list[str]): namespace-owed virtual paths.
        directory (str): the globbed directory, slash-terminated, with
            its marks off: a match is a real path a backend listed, so a
            glob character quoted in the directory's name is a character
            of it and the marked spelling would match no match at all.
        prefix (str): the mount prefix with no trailing slash.
        registry (MountRegistry): registry holding the mount table.
        mount (MountEntry): the mount owning the glob word.
    """
    specs = [
        s for s in (_as_spec(m, prefix) for m in matches)
        if s.virtual.startswith(directory) and s.virtual != directory
    ]
    seen = {s.virtual for s in specs}
    for virtual in extra:
        if virtual in seen:
            continue
        seen.add(virtual)
        # A nested mount root belongs to the mount it opens, not to the
        # one being listed, so it is keyed against its own backend.
        owner = _mount_of(registry, virtual, mount).prefix.rstrip("/")
        specs.append(PathSpec.from_str_path(virtual, mount_key(virtual,
                                                               owner)))
    return sorted(specs, key=lambda s: s.virtual)


def _mount_of(registry: MountRegistry, virtual: str,
              fallback: MountEntry) -> MountEntry:
    """The mount owning a path, falling back to the word's own.

    Args:
        registry (MountRegistry): registry holding the mount table.
        virtual (str): the virtual path to place.
        fallback (MountEntry): mount to use for a path outside the table.
    """
    mount = registry.try_mount_for(virtual)
    return mount if mount is not None else fallback


def _listing_dir(links: NamespaceLinks | None, directory: str) -> str:
    """The directory a backend must list to answer a glob's parent.

    bash descends through a symlinked directory during pathname
    expansion (``base/dlink/*`` and ``base/*/f2`` both reach the target's
    entries), but a link is namespace state no backend can see, so the
    parent has to be resolved here or the listing comes back empty and
    the word stays literal. The match keeps the typed spelling, exactly
    as bash reports ``base/dlink/f2`` rather than the target's path.

    Args:
        links (NamespaceLinks | None): the namespace symlink table.
        directory (str): the directory being globbed, slash-terminated.
    """
    if links is None:
        return directory
    base = directory.rstrip("/") or "/"
    try:
        real = links.follow(base)
    except CycleError:
        # A loop resolves to nothing, which is bash's own answer: the
        # word matches no file and stays literal.
        return directory
    return directory if real == base else real.rstrip("/") + "/"


def _respell(virtuals: list[str], directory: str) -> list[str]:
    """Move matches found under a resolved directory back to the typed one.

    Args:
        virtuals (list[str]): matches as the target directory names them.
        directory (str): the directory as typed, slash-terminated.
    """
    base = directory.rstrip("/")
    return [f"{base}/{v.rsplit('/', 1)[-1]}" for v in virtuals]


async def _level_matches(registry: MountRegistry, mount: MountEntry,
                         links: NamespaceLinks | None, dir_virtual: str,
                         seg: str) -> list[str]:
    """One descent step: the owning backend's matches plus the namespace's.

    The walk can cross into a nested mount, because a mid-path segment
    may match a mount root, so the backend asked is the one owning that
    parent rather than the one owning the typed word. It can equally
    descend through a symlinked directory, so the parent is resolved
    through the namespace first and the matches are spelled back under
    the name that was typed.

    Args:
        registry (MountRegistry): registry holding the mount table.
        mount (MountEntry): the mount owning the typed word.
        links (NamespaceLinks | None): the namespace symlink table.
        dir_virtual (str): the parent directory, slash-terminated.
        seg (str): the glob segment being matched.
    """
    real = _listing_dir(links, dir_virtual)
    owner = _mount_of(registry, real, mount)
    await owner.ensure_ready()
    prefix = owner.prefix.rstrip("/")
    spec = PathSpec(virtual=real,
                    directory=real,
                    resource_path=mount_key(real, prefix),
                    pattern=seg,
                    resolved=False)
    try:
        matches = await owner.expand_glob([spec], prefix)
    except OSError:
        # This parent is not a listable directory; bash skips it during
        # descent. A nested mount root or a link under it is still real.
        matches = []
    base = real.rstrip("/")
    # A descent step yields children, so a match that is the parent
    # itself is not one. A backend asked to list a path that is really a
    # file answers with that file, which walked back out as a doubled
    # segment (`/base/f*/f1` -> `/base/base/f1`); bash keeps the literal
    # because a file is not a directory to descend into.
    out = [
        v for v in (m.virtual if isinstance(m, PathSpec) else (
            m if m.startswith(prefix) else prefix + m)
                    for m in matches) if v.startswith(f"{base}/")
    ]
    out.extend(_namespace_children(registry, links, real, seg))
    return out if real == dir_virtual else _respell(out, dir_virtual)


async def _walk_segments(item: PathSpec, mount: MountEntry, prefix: str,
                         registry: MountRegistry,
                         links: NamespaceLinks | None) -> list[PathSpec]:
    """Expand a mid-path pattern level by level via resolve_glob.

    A glob in a non-final segment (``s*/x.txt``) cannot resolve in one
    listing: each glob segment is matched against its (already
    expanded) parent directory, using the backend's own single-level
    ``resolve_glob`` per parent, so no backend needs mid-path support.
    Matches are spelled the way bash expansion implies (typed head +
    matched tail). An intermediate match that cannot be listed is
    skipped, matching bash's directories-only descent.

    Args:
        item (PathSpec): the classify-shaped glob word.
        mount (MountEntry): the mount owning the word.
        prefix (str): the mount prefix with no trailing slash.
    """
    segments = item.virtual.strip("/").split("/")
    first = next(i for i, seg in enumerate(segments) if has_glob(seg))
    walked = len(segments) - first
    # The head above the first glob segment is a real directory, so a
    # glob character quoted inside it is part of the name to list.
    level = [unmark_globs("/" + "/".join(segments[:first]))]
    for seg in segments[first:]:
        gathered: list[str] = []
        for parent in level:
            gathered.extend(await _level_matches(registry, mount, links,
                                                 parent.rstrip("/") + "/",
                                                 seg))
        # bash sorts a pathname expansion, and the backend and the
        # namespace are enumerated separately, so the union is ordered
        # here.
        level = sorted(set(gathered))
        if not level:
            return []
    return _to_specs(level, item, registry, mount, walked)


def _join_spelling(head: str, name: str) -> str:
    """Append one segment to a typed spelling.

    Args:
        head (str): the spelling so far; empty for a word with no fixed
            head, `/` for an absolute one at the root.
        name (str): the segment to add.
    """
    if not head:
        return name
    return f"{head.rstrip('/')}/{name}"


async def _descend(registry: MountRegistry, mount: MountEntry,
                   links: NamespaceLinks | None, parent: str, spelled: str,
                   depth: int) -> list[tuple[str, str]]:
    """Every entry under a directory, at any depth, with its spelling.

    One listing per directory; a child that cannot be listed (a file)
    answers nothing and ends the branch, so no stat is spent telling
    the two apart. The leading-dot rule applies at each level exactly as
    for `*`, so a hidden directory is entered only under `dotglob`.

    Args:
        registry (MountRegistry): registry holding the mount table.
        mount (MountEntry): the mount owning the typed word.
        links (NamespaceLinks | None): the namespace symlink table.
        parent (str): the directory to descend from, no trailing slash.
        spelled (str): its typed spelling.
        depth (int): levels descended so far.
    """
    if depth >= GLOBSTAR_MAX_DEPTH:
        return []
    out: list[tuple[str, str]] = []
    for child in sorted(
            set(await _level_matches(registry, mount, links, parent + "/",
                                     "*"))):
        child_spelled = _join_spelling(spelled, child.rsplit("/", 1)[-1])
        out.append((child, child_spelled))
        out.extend(await _descend(registry, mount, links, child, child_spelled,
                                  depth + 1))
    return out


async def _walk_globstar(item: PathSpec, mount: MountEntry,
                         registry: MountRegistry,
                         links: NamespaceLinks | None) -> list[PathSpec]:
    """Expand a word holding a `**` segment under `shopt -s globstar`.

    A `**` segment matches zero or more directory levels: the parent
    itself (bash spells that one with a trailing slash when the word has
    a fixed head, `d/**` -> `d/`, and omits it for a bare `**`) plus
    every descendant. Any other segment matches one level as usual. The
    spelling is carried level by level rather than derived from a
    segment count, because a `**` that matched zero levels leaves the
    typed word and the match with different depths.

    Args:
        item (PathSpec): the classify-shaped glob word.
        mount (MountEntry): the mount owning the word.
        registry (MountRegistry): registry holding the mount table.
        links (NamespaceLinks | None): the namespace symlink table.
    """
    segments = item.virtual.strip("/").split("/")
    first = next(i for i, seg in enumerate(segments) if has_glob(seg))
    raw = unmark_globs(item.raw_path)
    raw_parts = raw.rstrip("/").split("/")
    raw_head = "/".join(raw_parts[:len(raw_parts) - (len(segments) - first)])
    if raw.startswith("/") and not raw_head:
        raw_head = "/"
    head = unmark_globs("/" + "/".join(segments[:first])).rstrip("/") or "/"
    level: list[tuple[str, str, bool]] = [(head, raw_head, False)]
    for seg in segments[first:]:
        gathered: list[tuple[str, str, bool]] = []
        for parent, spelled, _ in level:
            if seg == "**":
                gathered.append((parent, spelled, True))
                gathered.extend((v, sp, False) for v, sp in await _descend(
                    registry, mount, links, parent, spelled, 0))
                continue
            for child in await _level_matches(registry, mount, links,
                                              parent.rstrip("/") + "/", seg):
                gathered.append(
                    (child, _join_spelling(spelled,
                                           child.rsplit("/", 1)[-1]), False))
        seen: set[str] = set()
        level = []
        for entry in sorted(gathered, key=lambda e: e[0]):
            if entry[0] in seen:
                continue
            seen.add(entry[0])
            level.append(entry)
        if not level:
            return []
    # A `**` that matched zero levels at the end of the word is the head
    # itself, which bash spells with a trailing slash (`d/**` -> `d/`)
    # and leaves out entirely when there is no head (`**` alone).
    return [
        dataclasses.replace(PathSpec.from_str_path(
            v, mount_key(v,
                         _mount_of(registry, v, mount).prefix.rstrip("/"))),
                            raw_path=f"{sp.rstrip('/')}/" if is_self else sp)
        for v, sp, is_self in level if sp or not is_self
    ]


def _to_specs(virtuals: list[str], item: PathSpec, registry: MountRegistry,
              mount: MountEntry, walked: int) -> list[PathSpec]:
    """Key matched virtual paths to their mounts and spell them as typed.

    Args:
        virtuals (list[str]): the matched absolute virtual paths.
        item (PathSpec): the glob word they answer.
        registry (MountRegistry): registry holding the mount table.
        mount (MountEntry): the mount owning the word.
        walked (int): segment count from the word's first glob segment.
    """
    raw = unmark_globs(item.raw_path)
    return [
        dataclasses.replace(PathSpec.from_str_path(
            v, mount_key(v,
                         _mount_of(registry, v, mount).prefix.rstrip("/"))),
                            raw_path=spell_match(raw, v, walked))
        for v in virtuals
    ]


def _match_raw(item: PathSpec, match: PathSpec) -> PathSpec:
    """Stamp a glob match with the spelling the user's word implies.

    Bash expands `sub/*.txt` to relative matches (`sub/a.txt`), keeping
    the typed prefix. The glob item's raw_path records the word as
    typed; matches rebuild it by swapping the resolved directory prefix
    for the typed one. Words with no distinct spelling (absolute:
    raw_path == virtual) keep the resolved virtual, as do matches that
    already carry one.

    Args:
        item (PathSpec): the glob word being resolved.
        match (PathSpec): one resolved match.
    """
    raw = item.raw_path
    if raw == item.virtual or match.raw_path != match.virtual:
        return match
    # A mark is one character wide, so the directory's marked and
    # literal spellings are the same length and this cut holds either
    # way; only the head that is carried over has to lose its marks.
    if not match.virtual.startswith(unmark_globs(item.directory)):
        return match
    raw_dir = unmark_globs(raw[:raw.rfind("/") + 1])
    spelled = raw_dir + match.virtual[len(item.directory):]
    return dataclasses.replace(match, raw_path=spelled)


def _has_globstar_segment(item: PathSpec) -> bool:
    """Whether a word holds a segment that is exactly `**`.

    Args:
        item (PathSpec): the glob word.
    """
    return "**" in unmark_globs(item.virtual).split("/")


async def resolve_globs(
    classified: list[str | PathSpec],
    registry: MountRegistry,
    noglob: bool = False,
    links: NamespaceLinks | None = None,
    options: GlobOptions | None = None,
) -> list[str | PathSpec]:
    """Resolve glob patterns in PathSpec args, preserving PathSpec type.

    Globs are resolved via resource.resolve_glob. Non-glob PathSpec
    and plain str items pass through unchanged. Spec-TEXT words never
    arrive here as PathSpec: per-position kinds keep them plain text at
    classification time.

    Args:
        classified (list[str | PathSpec]): text arguments (str) and
            paths (PathSpec).
        registry (MountRegistry): mount registry.
        noglob (bool): ``set -f`` — skip resolution entirely, so every
            glob word keeps its literal spelling like a zero-match glob.
        links (NamespaceLinks | None): the namespace symlink table, so a
            glob sees links and nested mount roots the way a listing
            does. None outside a workspace.
        options (GlobOptions | None): the session's `shopt` glob
            options; None is bash's defaults (a zero-match glob stays
            the literal word, `**` reads as `*`).
    """
    if noglob:
        return [literal_word(item) for item in classified]
    opts = options if options is not None else GlobOptions()
    result: list[str | PathSpec] = []
    for item in classified:
        if isinstance(item, PathSpec) and item.pattern:
            pattern = item.pattern
            # A pattern word no mount owns cannot match anything, so it
            # stays the literal word like a zero-match glob.
            mount = registry.try_mount_for(item.virtual)
            if mount is None:
                result.append(item)
                continue
            prefix = mount.prefix.rstrip("/")
            # Stamp the backend key so readdir addresses the correct
            # resource-relative path.
            item = dataclasses.replace(item,
                                       resource_path=mount_key(
                                           item.virtual, prefix))
            await mount.ensure_ready()
            try:
                # The parent directory is a real directory to list, so a
                # glob character quoted inside it is part of its name.
                directory = unmark_globs(item.directory)
                if opts.globstar and _has_globstar_segment(item):
                    resolved = await _walk_globstar(item, mount, registry,
                                                    links)
                elif has_glob(item.directory):
                    resolved = await _walk_segments(item, mount, prefix,
                                                    registry, links)
                elif _listing_dir(links, directory) != directory:
                    # The parent is a symlink, so the backend holding the
                    # typed path has nothing to list; _level_matches
                    # follows it and spells the matches back.
                    resolved = _to_specs(
                        sorted(
                            set(await _level_matches(registry, mount, links,
                                                     directory, pattern))),
                        item, registry, mount, 1)
                else:
                    # Asked with the word, a backend that matched nothing
                    # answers with the word (nullglob off), which is
                    # byte-identical to a real match on a file named like
                    # the pattern -- `*a.txt` next to `xa.txt` lost its
                    # first match to that ambiguity. The directory-shaped
                    # spec has no literal to reinstate, so an empty list
                    # means no match and every spec returned is one.
                    resolved = _merge_namespace(
                        list(await mount.expand_glob([item.dir], prefix)),
                        _namespace_children(registry, links, directory,
                                            pattern), directory, prefix,
                        registry, mount)
                if not resolved:
                    # bash's three answers to a zero-match glob: the
                    # literal word (default), nothing at all under
                    # nullglob, and a fatal expansion error under
                    # failglob, which ends the line like a bad subscript.
                    if opts.failglob:
                        word = unmark_globs(item.raw_path)
                        raise ExitSignal(
                            1,
                            stderr=f"bash: no match: {word}\n".encode(),
                            contained_code=1)
                    if not opts.nullglob:
                        result.append(item)
                    continue
                for p in resolved:
                    result.append(_match_raw(item, _as_spec(p, prefix)))
            except (ValueError, AttributeError, TypeError):
                result.append(item)
        elif isinstance(item, PathSpec):
            result.append(item)
        else:
            result.append(item)
    # Resolution is over, so the quoting the marks carried has done its
    # work: what leaves is the word after quote removal, matched or not.
    return [literal_word(item) for item in result]


def _glob_head(spec: PathSpec) -> str:
    """The fixed directory above a word's first glob segment.

    Args:
        spec (PathSpec): the glob word.
    """
    fixed: list[str] = []
    for seg in spec.virtual.split("/"):
        if has_glob(seg):
            break
        fixed.append(seg)
    return "/".join(fixed) + "/"


async def expand_boundary_globs(
    parts: list[str | PathSpec],
    registry: MountRegistry,
    links: NamespaceLinks | None,
) -> list[str | PathSpec]:
    """Expand glob words that could match across a mount boundary.

    A glob operand is normally left for the owning backend to resolve,
    which is how a prefix store pushes the listing down. That only holds
    while every match belongs to that backend: a nested mount's root is a
    child of the directory but its keys live in another resource, so the
    backend answers "no such file" for a name its own listing shows. When
    the glob's fixed head holds a child mount, the word is expanded here
    instead, before routing, so the matches route per mount exactly as
    the same paths typed by hand already do. Every other glob is left
    untouched, so pushdown is unaffected.

    Args:
        parts (list[str | PathSpec]): the command's words after the name.
        registry (MountRegistry): registry holding the mount table.
        links (NamespaceLinks | None): the namespace symlink table.
    """
    prefixes = [m.prefix for m in registry.mounts()]
    if not any(
            isinstance(p, PathSpec) and p.pattern
            and child_mount_names(prefixes, _glob_head(p)) for p in parts):
        return parts
    out: list[str | PathSpec] = []
    for item in parts:
        if (isinstance(item, PathSpec) and item.pattern
                and child_mount_names(prefixes, _glob_head(item))):
            out.extend(await resolve_globs([item], registry, links=links))
        else:
            out.append(item)
    return out
