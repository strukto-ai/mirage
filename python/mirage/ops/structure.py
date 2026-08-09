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

from mirage.context import mount_allowed
from mirage.ops.config import NamespaceLinks
from mirage.types import FileStat, FileType


def _norm_dir(path: str) -> str:
    stripped = path.strip("/")
    return "/" + stripped + "/" if stripped else "/"


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
    norm = _norm_dir(parent)
    out: set[str] = set()
    for prefix in prefixes:
        p = _norm_dir(prefix)
        if p == norm or not p.startswith(norm):
            continue
        name = p[len(norm):].split("/", 1)[0]
        if not name or not mount_allowed(p):
            continue
        out.add(name)
    return sorted(out)


def _link_names(links: NamespaceLinks | None, parent: str) -> list[str]:
    if links is None:
        return []
    return [name for name in links.links_under(parent) if name]


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
    for name in child_mount_names(prefixes, parent) + _link_names(
            links, parent):
        if name in present:
            continue
        present.add(name)
        merged.append(f"{base}/{name}")
    return merged


def structure_listing(prefixes: Iterable[str], links: NamespaceLinks | None,
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
    if not child_mount_names(prefixes, parent) and not _link_names(
            links, parent):
        return None
    return merge_readdir([], prefixes, links, parent)


def structure_stat(prefixes: Iterable[str], links: NamespaceLinks | None,
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
    if structure_listing(prefixes, links, path) is None:
        return None
    name = path.rstrip("/").rsplit("/", 1)[-1] or "/"
    return FileStat(name=name, type=FileType.DIRECTORY)
