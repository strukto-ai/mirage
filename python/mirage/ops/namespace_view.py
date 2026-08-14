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

from mirage.context import mount_allowed, path_allowed
from mirage.ops.config import NamespaceLinks
from mirage.types import FileStat, FileType
from mirage.utils.path import norm_dir, owner_prefix


def child_mount_names(prefixes: Iterable[str], parent: str) -> list[str]:
    """Immediate child segments of mounts strictly under ``parent``.

    Session-filtered: a child name appears only when some mount whose
    prefix runs through it is visible to the current session, so a
    scoped session never learns an ungranted mount's name from a
    listing. Hidden names (leading dot) are included; presentation
    filtering is the consumer's job, exactly as for backend entries.

    Args:
        prefixes (Iterable[str]): the mount prefixes to derive from.
        parent (str): directory whose child mounts to enumerate.
    """
    norm = norm_dir(parent)
    out: set[str] = set()
    for prefix in prefixes:
        p = norm_dir(prefix)
        if p == norm or not p.startswith(norm):
            continue
        name = p[len(norm):].split("/", 1)[0]
        if not name or not mount_allowed(p) or not path_allowed(norm + name):
            continue
        out.add(name)
    return sorted(out)


def _link_allowed(prefixes: Iterable[str], link: str) -> bool:
    """Whether the current session may see the link at ``link``.

    A link is namespace state, but its path lies on some mount's turf:
    the longest mount prefix above it owns it, the same longest-match
    rule dispatch resolves the path by. A scoped session that may not
    touch that mount must not learn the link's name from a listing,
    exactly as ``child_mount_names`` hides the mount itself. A link
    above every mount is bare namespace structure and stays visible.

    Args:
        prefixes (Iterable[str]): the mount prefixes to derive from.
        link (str): the link's virtual path.
    """
    owner = owner_prefix(prefixes, link)
    return owner is None or mount_allowed(norm_dir(owner))


def _link_names(prefixes: Iterable[str], links: NamespaceLinks | None,
                parent: str) -> list[str]:
    """Immediate child segments owed to links at or below ``parent``.

    Derived from every link path, not just direct children, exactly as
    mount prefixes are: ``ln`` allows a link below a directory chain no
    backend serves, and without its ancestors synthesized the link
    lists at its own parent yet is unreachable from a walk above it.
    Session-filtered through ``_link_allowed``: a link below an
    ungranted mount would otherwise leak that mount's name into a
    listing ``child_mount_names`` had already filtered.

    Args:
        prefixes (Iterable[str]): the mount prefixes to derive from.
        links (NamespaceLinks | None): the namespace symlink table.
        parent (str): directory whose child segments to enumerate.
    """
    if links is None:
        return []
    norm = norm_dir(parent)
    out: set[str] = set()
    for link in links.symlink_targets():
        if not link.startswith(norm):
            continue
        name = link[len(norm):].split("/", 1)[0]
        if (name and _link_allowed(prefixes, link)
                and path_allowed(norm + name)):
            out.add(name)
    return sorted(out)


def namespace_names(prefixes: Iterable[str], links: NamespaceLinks | None,
                    parent: str) -> list[str]:
    """Every child segment the namespace owes ``parent``: mounts + links.

    The one union both consumers derive from: the door merges these
    names into its readdir and the ``child_mounts`` fact offers them to
    listing commands, so the shell and the ops surface cannot disagree
    about what a directory holds.

    Args:
        prefixes (Iterable[str]): the mount prefixes to derive from.
        links (NamespaceLinks | None): the namespace symlink table.
        parent (str): directory whose child segments to enumerate.
    """
    return sorted(
        set(child_mount_names(prefixes, parent))
        | set(_link_names(prefixes, links, parent)))


def merge_readdir(entries: list[str], prefixes: Iterable[str],
                  links: NamespaceLinks | None, parent: str) -> list[str]:
    """Merge namespace structure into a backend readdir listing.

    Child mounts and symlinks are namespace state no backend can see,
    so a listing that stops at one backend misses both. Merged names are
    appended as virtual paths (the shape RAM-style backends already
    emit); deduplication is by final path segment because backends
    disagree on entry shape (bare names, trailing-slash names, full
    paths).

    Args:
        entries (list[str]): the backend's own listing.
        prefixes (Iterable[str]): the mount prefixes to derive from.
        links (NamespaceLinks | None): the namespace symlink table.
        parent (str): the directory that was listed, as a virtual path.
    """
    present = {e.rstrip("/").rsplit("/", 1)[-1] for e in entries}
    base = parent.rstrip("/")
    merged = list(entries)
    for name in namespace_names(prefixes, links, parent):
        if name in present:
            continue
        present.add(name)
        merged.append(f"{base}/{name}")
    return merged


def namespace_listing(prefixes: Iterable[str], links: NamespaceLinks | None,
                      parent: str) -> list[str] | None:
    """A listing for a directory that exists only as namespace structure.

    ``/data/x`` exists when a mount sits at ``/data/x/y`` or a link
    lives directly under it, even though the ``/data`` backend holds
    nothing at ``/x``. None when the namespace knows nothing there
    either, so a caller re-raises the backend's miss.

    Args:
        prefixes (Iterable[str]): the mount prefixes to derive from.
        links (NamespaceLinks | None): the namespace symlink table.
        parent (str): the directory that was listed, as a virtual path.
    """
    if not namespace_names(prefixes, links, parent):
        return None
    return merge_readdir([], prefixes, links, parent)


def namespace_stat(prefixes: Iterable[str], links: NamespaceLinks | None,
                   path: str) -> FileStat | None:
    """A directory stat for a path that exists only as namespace structure.

    The listing and the stat must agree: a directory ``readdir`` can
    serve (because a mount or a link sits below it) must stat as a
    directory, or ``os.walk`` and ``Path.is_dir`` break on it.

    Args:
        prefixes (Iterable[str]): the mount prefixes to derive from.
        links (NamespaceLinks | None): the namespace symlink table.
        path (str): the path that was statted, as a virtual path.
    """
    if namespace_listing(prefixes, links, path) is None:
        return None
    name = path.rstrip("/").rsplit("/", 1)[-1] or "/"
    return FileStat(name=name, type=FileType.DIRECTORY)
