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

import asyncio
from collections.abc import Iterable
from dataclasses import dataclass

from mirage.resource.base import BaseResource
from mirage.types import DEFAULT_AGENT_ID, MountMode, NodeMetaKey
from mirage.utils.path import glob_prefix_match, resolve_symlinks
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.mount.namespace.ram import RAMNamespaceStore
from mirage.workspace.mount.namespace.store import NamespaceStore, NodeFields
from mirage.workspace.mount.registry import MountRegistry


@dataclass(slots=True)
class NodeMeta:
    """Per-path namespace metadata.

    Two roles, distinguished by ``target``: a target-bearing entry is an
    authoritative symlink (the link exists only here); a target-less entry
    is a metadata overlay for a backend file whose backend has no native
    attribute slot. Attributes are stored, not enforced: mount mode does
    real access control.
    """

    target: str | None = None
    mtime: float | None = None
    mode: int | None = None
    uid: int | str | None = None
    gid: int | str | None = None
    atime: str | None = None

    def is_empty(self) -> bool:
        return all(getattr(self, key) is None for key in NodeMetaKey)

    def to_fields(self) -> NodeFields:
        return {
            str(key): value
            for key in NodeMetaKey if (value := getattr(self, key)) is not None
        }

    @classmethod
    def from_fields(cls, entry: NodeFields) -> "NodeMeta":
        target = entry.get(NodeMetaKey.TARGET)
        mtime = entry.get(NodeMetaKey.MTIME)
        mode = entry.get(NodeMetaKey.MODE)
        uid = entry.get(NodeMetaKey.UID)
        gid = entry.get(NodeMetaKey.GID)
        atime = entry.get(NodeMetaKey.ATIME)
        return cls(
            target=target if isinstance(target, str) else None,
            mtime=float(mtime) if isinstance(mtime, (int, float)) else None,
            mode=mode if isinstance(mode, int) else None,
            uid=uid if isinstance(uid, (int, str)) else None,
            gid=gid if isinstance(gid, (int, str)) else None,
            atime=atime if isinstance(atime, str) else None,
        )


class Namespace:
    """Addressing authority: maps virtual paths to their mounts.

    Owns the mount registry and the per-path node-metadata table (symlinks
    plus the attribute overlay). Pure addressing: it resolves a virtual
    path to its mount and backend-relative path, following symlinks and
    crossing mounts. It holds no cache and performs no backend I/O. Op
    execution and caching live in the Dispatcher, which calls this layer
    to locate the mount.

    The in-memory table is the working copy (reads stay synchronous on
    the hot path); every mutation writes through to a ``NamespaceStore``
    (RAM by default, Redis for restart-durable namespaces), and the
    table hydrates from the store once on first use.

    Symlinks are stored verbatim as typed: the target string is kept exactly
    as the user wrote it (relative targets are resolved lazily against the
    link's own parent at resolution time), so ``readlink`` is GNU-faithful.
    """

    def __init__(self,
                 registry: MountRegistry,
                 store: NamespaceStore | None = None,
                 user: str | None = None) -> None:
        self._registry = registry
        self._store = store if store is not None else RAMNamespaceStore()
        self._nodes: dict[str, NodeMeta] = {}
        self._loaded = False
        self._load_lock = asyncio.Lock()
        self._claim = user
        self._user: str | None = None
        self._user_resolved = False

    @property
    def registry(self) -> MountRegistry:
        return self._registry

    @property
    def nodes(self) -> dict[str, NodeMeta]:
        return self._nodes

    @property
    def user(self) -> str:
        """The workspace user (whoami identity).

        Before store resolution the launch claim (or DEFAULT_AGENT_ID)
        answers; after it, the resolved identity.
        """
        if self._user is not None:
            return self._user
        if self._claim is not None:
            return self._claim
        return DEFAULT_AGENT_ID

    async def _resolve_user(self) -> None:
        """Resolve the workspace user against the store, once.

        An explicit launch claim wins and writes through; without one the
        stored identity is adopted, so a runtime attaching to a shared
        store (e.g. Redis) inherits the workspace's whoami.
        """
        if self._user_resolved:
            return
        stored = await self._store.load_user()
        if self._claim is not None:
            self._user = self._claim
            if stored != self._claim:
                await self._store.set_user(self._claim)
        else:
            self._user = stored
        self._user_resolved = True

    async def ensure_loaded(self) -> None:
        """Hydrate the working copy from the store, once.

        A snapshot restore (``replace_nodes``) marks the table loaded, so
        snapshot state wins over whatever the store held before it.
        """
        if self._loaded and self._user_resolved:
            return
        async with self._load_lock:
            if not self._loaded:
                entries = await self._store.load()
                self._nodes = {
                    path: NodeMeta.from_fields(entry)
                    for path, entry in entries.items()
                }
                self._loaded = True
            await self._resolve_user()

    async def replace_nodes(self, entries: dict[str, NodeMeta]) -> None:
        self._nodes = dict(entries)
        self._loaded = True
        await self._resolve_user()
        await self._store.replace_all({
            path: meta.to_fields()
            for path, meta in entries.items()
        })

    async def close(self) -> None:
        await self._store.close()

    def symlink_targets(self) -> dict[str, str]:
        return {
            path: meta.target
            for path, meta in self._nodes.items() if meta.target is not None
        }

    def has_links(self) -> bool:
        return any(meta.target is not None for meta in self._nodes.values())

    def is_link(self, path: str) -> bool:
        meta = self._nodes.get(path)
        return meta is not None and meta.target is not None

    def readlink(self, path: str) -> str | None:
        meta = self._nodes.get(path)
        return meta.target if meta is not None else None

    async def symlink(self, link: str, target: str, mtime: float) -> None:
        meta = self._nodes.setdefault(link, NodeMeta())
        meta.target = target
        meta.mtime = mtime
        await self._store.set(link, meta.to_fields())

    def meta_for(self, path: str) -> NodeMeta | None:
        return self._nodes.get(path)

    async def set_attrs(
        self,
        path: str,
        *,
        mode: int | None = None,
        uid: int | str | None = None,
        gid: int | str | None = None,
        atime: str | None = None,
        mtime: float | None = None,
    ) -> None:
        """Write overlay attributes for a path (setattr fallback).

        Used for symlinks (which have no backend inode) and for backends
        without a native metadata slot. Only non-None fields are written.

        Args:
            path (str): absolute virtual path.
            mode (int | None): permission bits (e.g. 0o644).
            uid (int | str | None): owner id or name.
            gid (int | str | None): group id or name.
            atime (str | None): ISO access time.
            mtime (float | None): modification time (epoch seconds).
        """
        meta = self._nodes.setdefault(path, NodeMeta())
        if mode is not None:
            meta.mode = mode
        if uid is not None:
            meta.uid = uid
        if gid is not None:
            meta.gid = gid
        if atime is not None:
            meta.atime = atime
        if mtime is not None:
            meta.mtime = mtime
        await self._store.set(path, meta.to_fields())

    async def drop_attrs(self, path: str, fields: Iterable[str]) -> None:
        """Drop overlay fields that a backend has applied natively.

        A residual-free native setattr means the real inode now holds the
        requested value, so a stale overlay field would shadow it forever
        (chmod 000 then chmod 644 must not keep showing 000). Symlink
        entries keep their target.

        Args:
            path (str): absolute virtual path.
            fields (Iterable[str]): NodeMeta field names to drop.
        """
        meta = self._nodes.get(path)
        if meta is None:
            return
        for field in fields:
            if field != str(NodeMetaKey.TARGET):
                setattr(meta, field, None)
        if meta.is_empty():
            del self._nodes[path]
            await self._store.delete([path])
            return
        await self._store.set(path, meta.to_fields())

    async def clear_times(self, path: str) -> None:
        """Drop overlay times after a content write.

        write(2) refreshes mtime, so a stored overlay time would
        otherwise shadow the backend's fresh one forever. Permission and
        ownership survive writes; a symlink entry keeps its own times.

        Args:
            path (str): absolute virtual path that was written.
        """
        meta = self._nodes.get(path)
        if meta is None or meta.target is not None:
            return
        meta.mtime = None
        meta.atime = None
        if meta.is_empty():
            del self._nodes[path]
            await self._store.delete([path])
            return
        await self._store.set(path, meta.to_fields())

    async def unlink(self, path: str) -> bool:
        if path in self._nodes:
            del self._nodes[path]
            await self._store.delete([path])
            return True
        return False

    async def unlink_glob(self, pattern: str) -> int:
        """Drop node entries matching an unexpanded glob operand.

        ``rm`` receives the pattern verbatim (backend wrappers expand
        globs themselves), so the node table must match it here. Drops
        matched entries and everything under a matched directory.

        Args:
            pattern (str): absolute virtual glob pattern.

        Returns:
            int: number of entries dropped.
        """
        doomed = [
            path for path in self._nodes if glob_prefix_match(path, pattern)
        ]
        for path in doomed:
            del self._nodes[path]
        if doomed:
            await self._store.delete(doomed)
        return len(doomed)

    async def rename(self, src: str, dst: str) -> bool:
        meta = self._nodes.pop(src, None)
        if meta is None:
            return False
        self._nodes[dst] = meta
        await self._store.set(dst, meta.to_fields())
        await self._store.delete([src])
        return True

    def follow(self, path: str) -> str:
        """Return ``path`` with all symlink prefixes resolved.

        Identity when no link entries exist or nothing matches.

        Args:
            path (str): absolute virtual path.

        Raises:
            CycleError: when resolution exceeds the hop limit (ELOOP).
        """
        targets = self.symlink_targets()
        if not targets:
            return path
        return resolve_symlinks(path, targets)

    def links_under(self, directory: str) -> dict[str, str]:
        """Links living directly under a directory.

        Args:
            directory (str): absolute virtual directory path.

        Returns:
            dict[str, str]: link basename to target, for entries whose
            parent is exactly ``directory``.
        """
        base = directory.rstrip("/") + "/"
        out: dict[str, str] = {}
        for path, meta in self._nodes.items():
            if (meta.target is not None and path.startswith(base)
                    and "/" not in path[len(base):]):
                out[path[len(base):]] = meta.target
        return out

    async def purge_under(self, directory: str) -> int:
        """Drop every node entry under a directory (``rm -r`` semantics).

        Args:
            directory (str): absolute virtual directory path being removed.

        Returns:
            int: number of entries dropped.
        """
        base = directory.rstrip("/") + "/"
        doomed = [path for path in self._nodes if path.startswith(base)]
        for path in doomed:
            del self._nodes[path]
        if doomed:
            await self._store.delete(doomed)
        return len(doomed)

    def resolve(self,
                path: str,
                *,
                follow: bool = True) -> tuple[BaseResource, str, MountMode]:
        """Map a virtual path to ``(resource, resource_path, mode)``.

        Args:
            path (str): virtual path to resolve.
            follow (bool): follow symlinks (the node table) before mapping
                the path to its mount.

        Raises:
            CycleError: when symlink resolution exceeds the hop limit (ELOOP).
        """
        if follow:
            path = self.follow(path)
        return self._registry.resolve(path)

    def mount_for(self, path: str) -> MountEntry:
        return self._registry.mount_for(path)

    def is_mount_root(self, path: str) -> bool:
        return self._registry.is_mount_root(path)
