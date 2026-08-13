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
from mirage.types import PathSpec
from mirage.utils.fnmatch import fnmatch
from mirage.utils.glob_walk import has_glob, spell_match
from mirage.utils.key_prefix import mount_key
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.mount import MountEntry


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
    return [
        f"{base}/{name}" for name in namespace_names(
            [m.prefix for m in registry.mounts()], links, directory)
        if fnmatch(name, pattern)
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


def _merge_namespace(item: PathSpec, matches: list[str | PathSpec],
                     extra: list[str], prefix: str, registry: MountRegistry,
                     mount: MountEntry) -> list[PathSpec]:
    """Union a backend's matches with the namespace-owed ones.

    Sorted, because bash sorts a pathname expansion and the two sources
    are enumerated separately. A backend that matched nothing answers
    with the literal word (nullglob off); that is "no match", not an
    entry to merge against, so it is dropped here and the literal is
    reinstated by the caller only if the union is empty too.

    Args:
        item (PathSpec): the glob word being resolved.
        matches (list[str | PathSpec]): the backend's own matches.
        extra (list[str]): namespace-owed virtual paths.
        prefix (str): the mount prefix with no trailing slash.
        registry (MountRegistry): registry holding the mount table.
        mount (MountEntry): the mount owning the glob word.
    """
    specs = [
        s for s in (_as_spec(m, prefix) for m in matches)
        if s.virtual != item.virtual
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
    try:
        return registry.mount_for(virtual)
    except ValueError:
        return fallback


async def _level_matches(registry: MountRegistry, mount: MountEntry,
                         links: NamespaceLinks | None, dir_virtual: str,
                         seg: str) -> list[str]:
    """One descent step: the owning backend's matches plus the namespace's.

    The walk can cross into a nested mount, because a mid-path segment
    may match a mount root, so the backend asked is the one owning that
    parent rather than the one owning the typed word.

    Args:
        registry (MountRegistry): registry holding the mount table.
        mount (MountEntry): the mount owning the typed word.
        links (NamespaceLinks | None): the namespace symlink table.
        dir_virtual (str): the parent directory, slash-terminated.
        seg (str): the glob segment being matched.
    """
    owner = _mount_of(registry, dir_virtual, mount)
    prefix = owner.prefix.rstrip("/")
    spec = PathSpec(virtual=dir_virtual,
                    directory=dir_virtual,
                    resource_path=mount_key(dir_virtual, prefix),
                    pattern=seg,
                    resolved=False)
    try:
        matches = await owner.resource.resolve_glob([spec], prefix=prefix)
    except OSError:
        # This parent is not a listable directory; bash skips it during
        # descent. A nested mount root or a link under it is still real.
        matches = []
    out = [
        m.virtual if isinstance(m, PathSpec) else
        (m if m.startswith(prefix) else prefix + m) for m in matches
    ]
    out.extend(_namespace_children(registry, links, dir_virtual, seg))
    return out


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
    level = ["/" + "/".join(segments[:first])]
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
    item_raw = item.raw_path
    return [
        dataclasses.replace(PathSpec.from_str_path(
            v, mount_key(v,
                         _mount_of(registry, v, mount).prefix.rstrip("/"))),
                            raw_path=spell_match(item_raw, v, walked))
        for v in level
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
    if not match.virtual.startswith(item.directory):
        return match
    raw_dir = raw[:raw.rfind("/") + 1]
    spelled = raw_dir + match.virtual[len(item.directory):]
    return dataclasses.replace(match, raw_path=spelled)


async def resolve_globs(
    classified: list[str | PathSpec],
    registry: MountRegistry,
    noglob: bool = False,
    links: NamespaceLinks | None = None,
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
    """
    if noglob:
        return list(classified)
    result: list[str | PathSpec] = []
    for item in classified:
        if isinstance(item, PathSpec) and item.pattern:
            pattern = item.pattern
            try:
                mount = registry.mount_for(item.virtual)
                prefix = mount.prefix.rstrip("/")
                # Stamp the backend key so readdir addresses the correct
                # resource-relative path.
                item = dataclasses.replace(item,
                                           resource_path=mount_key(
                                               item.virtual, prefix))
                if has_glob(item.directory):
                    resolved = await _walk_segments(item, mount, prefix,
                                                    registry, links)
                else:
                    resolved = _merge_namespace(
                        item,
                        list(await mount.resource.resolve_glob([item],
                                                               prefix=prefix)),
                        _namespace_children(registry, links, item.directory,
                                            pattern), prefix, registry, mount)
                # bash with nullglob off: a zero-match glob stays the
                # literal word instead of vanishing.
                if not resolved:
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
    return result


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
