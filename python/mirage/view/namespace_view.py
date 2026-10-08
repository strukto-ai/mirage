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

from collections.abc import Iterable, Sequence

from mirage.types import FileStat, FileType, PathSpec, Visibility
from mirage.utils.hidden import path_visible
from mirage.utils.path import norm_dir
from mirage.view.types import NamespaceLinks, NamespaceView


def visible_child_segments(
    vis: Visibility | None, paths: Iterable[str], parent: str
) -> list[str]:
    """The child segments of ``parent`` that some allowed path runs through.

    The one session filter both namespace enumerations share, because
    both owe a segment to a deeper thing rather than to an entry of its
    own: a mount prefix and a link path each synthesize every directory
    above it, and the segment is visible exactly when at least one of
    the things that synthesized it is.

    The full path is what gets tested, never the segment. A hide is
    subtree-closed on all three of its planes (an exact entry contains
    its subtree, a component pattern matches any segment, an anchored
    one is tested against every ancestor), so testing the deeper path is
    strictly stronger: a segment can only be withheld by this, never
    granted. Testing the segment instead is what leaked the name of a
    namespace-only ancestor whose only mount or link the session hides,
    a directory that answers ENOENT to every verb applied to it.

    Args:
        vis (Visibility | None): the session's visibility.
        paths (Iterable[str]): full paths owing ``parent`` a segment,
            mount prefixes or link paths.
        parent (str): directory whose child segments to enumerate.
    """
    norm = norm_dir(parent)
    out: set[str] = set()
    for path in paths:
        if not path.startswith(norm):
            continue
        name = path[len(norm) :].split("/", 1)[0]
        if not name or name in out or not path_visible(vis, path):
            continue
        out.add(name)
    return sorted(out)


def child_mount_names(
    vis: Visibility | None, prefixes: Iterable[str], parent: str
) -> list[str]:
    """Immediate child segments of mounts strictly under ``parent``.

    Session-filtered by :func:`visible_child_segments`: a child name
    appears only when some mount whose prefix runs through it is visible
    to the current session, so a scoped session never learns an
    ungranted mount's name from a listing. Hidden names (leading dot)
    are included; presentation filtering is the consumer's job, exactly
    as for backend entries.

    Args:
        vis (Visibility | None): the session's visibility.
        prefixes (Iterable[str]): the mount prefixes to derive from.
        parent (str): directory whose child mounts to enumerate.
    """
    norm = norm_dir(parent)
    below = [
        norm_dir(prefix).rstrip("/")
        for prefix in prefixes
        if norm_dir(prefix) != norm and norm_dir(prefix).startswith(norm)
    ]
    return visible_child_segments(vis, below, parent)


def _link_names(
    vis: Visibility | None, links: NamespaceLinks | None, parent: str
) -> list[str]:
    """Immediate child segments owed to links at or below ``parent``.

    Derived from every link path, not just direct children, exactly as
    mount prefixes are: ``ln`` allows a link below a directory chain no
    backend serves, and without its ancestors synthesized the link
    lists at its own parent yet is unreachable from a walk above it.
    Session-filtered by :func:`visible_child_segments`, the same
    predicate ``child_mount_names`` applies to a mount prefix: the link
    path is tested, not the segment, so a namespace-only ancestor whose
    only link the session hides is not named either.

    Args:
        vis (Visibility | None): the session's visibility.
        links (NamespaceLinks | None): the namespace symlink table.
        parent (str): directory whose child segments to enumerate.
    """
    if links is None:
        return []
    return visible_child_segments(vis, links.symlink_targets(), parent)


def namespace_names(
    vis: Visibility | None,
    prefixes: Iterable[str],
    links: NamespaceLinks | None,
    parent: str,
) -> list[str]:
    """Every child segment the namespace owes ``parent``: mounts + links.

    The one union both consumers derive from: the door merges these
    names into its readdir and the ``child_mounts`` fact offers them to
    listing commands, so the shell and the ops surface cannot disagree
    about what a directory holds.

    Args:
        vis (Visibility | None): the session's visibility.
        prefixes (Iterable[str]): the mount prefixes to derive from.
        links (NamespaceLinks | None): the namespace symlink table.
        parent (str): directory whose child segments to enumerate.
    """
    return sorted(
        set(child_mount_names(vis, prefixes, parent))
        | set(_link_names(vis, links, parent))
    )


def merge_readdir(
    vis: Visibility | None,
    entries: list[str],
    prefixes: Iterable[str],
    links: NamespaceLinks | None,
    parent: str,
) -> list[str]:
    """Merge namespace structure into a backend readdir listing.

    Child mounts and symlinks are namespace state no backend can see,
    so a listing that stops at one backend misses both. Merged names are
    appended as virtual paths (the shape RAM-style backends already
    emit); deduplication is by final path segment because backends
    disagree on entry shape (bare names, trailing-slash names, full
    paths).

    Args:
        vis (Visibility | None): the session's visibility.
        entries (list[str]): the backend's own listing.
        prefixes (Iterable[str]): the mount prefixes to derive from.
        links (NamespaceLinks | None): the namespace symlink table.
        parent (str): the directory that was listed, as a virtual path.
    """
    present = {e.rstrip("/").rsplit("/", 1)[-1] for e in entries}
    base = parent.rstrip("/")
    merged = list(entries)
    for name in namespace_names(vis, prefixes, links, parent):
        if name in present:
            continue
        present.add(name)
        merged.append(f"{base}/{name}")
    return merged


def namespace_listing(
    vis: Visibility | None,
    prefixes: Iterable[str],
    links: NamespaceLinks | None,
    parent: str,
) -> list[str] | None:
    """A listing for a directory that exists only as namespace structure.

    ``/data/x`` exists when a mount sits at ``/data/x/y`` or a link
    lives directly under it, even though the ``/data`` backend holds
    nothing at ``/x``. None when the namespace knows nothing there
    either, so a caller re-raises the backend's miss.

    Args:
        vis (Visibility | None): the session's visibility.
        prefixes (Iterable[str]): the mount prefixes to derive from.
        links (NamespaceLinks | None): the namespace symlink table.
        parent (str): the directory that was listed, as a virtual path.
    """
    if not namespace_names(vis, prefixes, links, parent):
        return None
    return merge_readdir(vis, [], prefixes, links, parent)


def namespace_stat(
    vis: Visibility | None,
    prefixes: Iterable[str],
    links: NamespaceLinks | None,
    path: str,
) -> FileStat | None:
    """A directory stat for a path that exists only as namespace structure.

    The listing and the stat must agree: a directory ``readdir`` can
    serve (because a mount or a link sits below it) must stat as a
    directory, or ``os.walk`` and ``Path.is_dir`` break on it.

    Args:
        vis (Visibility | None): the session's visibility.
        prefixes (Iterable[str]): the mount prefixes to derive from.
        links (NamespaceLinks | None): the namespace symlink table.
        path (str): the path that was statted, as a virtual path.
    """
    if namespace_listing(vis, prefixes, links, path) is None:
        return None
    name = path.rstrip("/").rsplit("/", 1)[-1] or "/"
    return FileStat(name=name, type=FileType.DIRECTORY)


def paths_scoped(
    ns: NamespaceView | None, paths: Sequence[PathSpec], prefix: str = ""
) -> bool:
    """Whether a hide, a path rule or a pre_vfs policy judges anything a
    command's operands reach, so a native walk that classifies the raw
    tree gives way to the checked one.

    Per operand, not per session: a hidden ``.env`` under ``/repo`` must
    not force ``find`` on ``/s3`` off its native op.

    Args:
        ns (NamespaceView | None): the command's namespace view, whose
            ``scoped`` answers per path; None judges nothing.
        paths (Sequence[PathSpec]): the operands, a default cwd
            included.
        prefix (str): the mount root, judged in place of a glob operand.
    """
    scoped = ns.scoped if ns is not None else None
    return scoped is not None and any(
        scoped(prefix or "/" if path.pattern is not None else path.virtual)
        for path in paths
    )
