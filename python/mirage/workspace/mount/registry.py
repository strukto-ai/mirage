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

from typing import Protocol

from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.general import COMMANDS as GENERAL_COMMANDS
from mirage.ops.config import OpsMount
from mirage.resource.base import BaseResource
from mirage.resource.dev import DevResource
from mirage.runtime.js.base import JsRuntime
from mirage.runtime.python.base import PythonRuntime
from mirage.types import ConsistencyPolicy, MountMode, PathSpec
from mirage.workspace.mount.mount import MountEntry

DEV_PREFIX = "/dev/"


class ReadReconciler(Protocol):
    """The one thing the registry needs from a reconciler.

    Depending on this local interface (not the concrete ``Reconciler``)
    keeps the dependency pointing down: ``reconcile`` imports the mount
    layer, not the other way round. The Reconciler satisfies it structurally.
    """

    async def reconcile_read(self, mount: MountEntry, path: str) -> None:
        ...


class MountCommandUnsupported(Exception):
    """Raised when a path-bound command is unsupported by its backend.

    Rendered in the GNU shape ``<cmd>: <operand>: <reason>`` with the
    EOPNOTSUPP strerror, naming the offending path like coreutils does;
    the backend name stays on the exception for programmatic use (#394).
    """

    def __init__(self, cmd_name: str, backend: str, operand: str) -> None:
        self.cmd_name = cmd_name
        self.backend = backend
        self.operand = operand
        super().__init__(f"{cmd_name}: {operand}: Operation not supported")


class MountRegistry:
    """Longest-prefix-match router.

    Given a virtual path like "/s3-prod/data/file.json",
    resolves to the mount at "/s3-prod/" and returns the
    stripped resource path "/data/file.json".
    """

    def __init__(self) -> None:
        self._mounts: list[MountEntry] = []
        self._root: MountEntry | None = None
        # Workspace-level Python runtime for `python3`, set by Workspace
        # after construction (same vehicle as is_exec_allowed()).
        self.python_runtime: PythonRuntime | None = None
        # Workspace-level JavaScript runtime for `node`/`js`.
        self.js_runtime: JsRuntime | None = None
        self._consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY
        self._file_cache: FileCacheMixin | None = None
        self._reconciler: ReadReconciler | None = None
        self.mount(DEV_PREFIX, DevResource(), MountMode.WRITE)

    def set_consistency(self, consistency: ConsistencyPolicy) -> None:
        self._consistency = consistency

    def set_reconciler(self, reconciler: ReadReconciler) -> None:
        self._reconciler = reconciler

    def attach_file_cache(self, cache: FileCacheMixin | None) -> None:
        """Attach the workspace file cache and build per-mount
        CacheManagers.

        Called once by Workspace after the cache store exists. Mounts
        added later get their manager in ``mount()``.

        Args:
            cache (FileCacheMixin | None): Workspace file cache store.
        """
        self._file_cache = cache
        for m in self._mounts:
            self._attach_manager(m)

    def _attach_manager(self, m: MountEntry) -> None:
        m.cache_manager = CacheManager(self._file_cache, m.resource.index,
                                       m.prefix, m.resource.caches_reads)

    def mount(
        self,
        prefix: str,
        resource: BaseResource,
        mode: MountMode = MountMode.READ,
        consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY,
    ) -> MountEntry:
        """Mount a resource and return the Mount object."""
        stripped = prefix.strip("/")
        norm_prefix = ("/" + stripped + "/" if stripped else "/")
        for existing in self._mounts:
            if existing.prefix == norm_prefix:
                raise ValueError(f"duplicate mount prefix: "
                                 f"{norm_prefix!r}")
        m = MountEntry(norm_prefix, resource, mode, consistency)
        for cmd in resource.commands():
            m.register(cmd)
        for cmd in GENERAL_COMMANDS:
            m.register_general(cmd)
        for ro in resource.ops_list():
            m.register_op(ro)
        if self._file_cache is not None:
            self._attach_manager(m)
        self._mounts.append(m)
        self._mounts.sort(key=lambda x: len(x.prefix), reverse=True)
        if norm_prefix == "/":
            self._root = m
        return m

    def unmount(self, prefix: str) -> MountEntry:
        """Remove a mount by exact prefix and return it.

        Per-mount commands and ops live on the Mount instance and die with
        it. The /dev/ mount is reserved and cannot be removed.

        Args:
            prefix (str): mount prefix.
        """
        stripped = prefix.strip("/")
        norm_prefix = ("/" + stripped + "/" if stripped else "/")
        if norm_prefix == DEV_PREFIX:
            raise ValueError(f"cannot unmount reserved prefix: "
                             f"{norm_prefix!r}")
        for i, m in enumerate(self._mounts):
            if m.prefix == norm_prefix:
                del self._mounts[i]
                if m is self._root:
                    self._root = None
                return m
        raise ValueError(f"no mount at prefix: {norm_prefix!r}")

    def resolve(
        self,
        path: str,
    ) -> tuple[BaseResource, str, MountMode]:
        """Returns (resource, resource_path, mode)."""
        had_trailing = path.endswith("/")
        norm = "/" + path.strip("/")
        for m in self._mounts:
            if (norm == m.prefix.rstrip("/") or norm.startswith(m.prefix)):
                resource_path = "/" + norm[len(m.prefix):]
                if (had_trailing and not resource_path.endswith("/")):
                    resource_path += "/"
                return m.resource, resource_path, m.mode
        raise ValueError(f"no mount matches path: {path!r}")

    def mount_for_prefix(self, prefix: str) -> MountEntry:
        for m in self._mounts:
            if m.prefix == prefix:
                return m
        raise ValueError(f"no mount with prefix {prefix!r}")

    def is_mount_root(self, path: str) -> bool:
        stripped = path.strip("/")
        norm = "/" + stripped + "/" if stripped else "/"
        return any(m.prefix == norm for m in self._mounts)

    def descendant_mounts(self, path: str) -> list[MountEntry]:
        """Mounts whose prefix is strictly under `path`.

        Used by traversal commands (find, tree, du, grep -r) to fan out
        across nested mounts. Excludes the mount that contains `path`
        itself; callers should add that mount via `mount_for(path)`.

        Args:
            path (str): parent path to scan beneath.
        """
        stripped = path.strip("/")
        norm = "/" + stripped + "/" if stripped else "/"
        out: list[MountEntry] = []
        for m in self._mounts:
            if m.prefix == norm:
                continue
            if not m.prefix.startswith(norm):
                continue
            out.append(m)
        out.sort(key=lambda m: m.prefix)
        return out

    def child_mount_names(
        self,
        parent_path: str,
        include_hidden: bool = False,
    ) -> list[str]:
        """Names of immediate child mounts under parent_path.

        Args:
            parent_path (str): directory whose child mounts to enumerate.
            include_hidden (bool): include names starting with '.'.
        """
        stripped = parent_path.strip("/")
        norm = "/" + stripped + "/" if stripped else "/"
        seen: set[str] = set()
        out: list[str] = []
        for m in self._mounts:
            if m.prefix == norm:
                continue
            if not m.prefix.startswith(norm):
                continue
            rest = m.prefix[len(norm):]
            slash = rest.find("/")
            name = rest if slash == -1 else rest[:slash]
            if name == "":
                continue
            if not include_hidden and name.startswith("."):
                continue
            if name in seen:
                continue
            seen.add(name)
            out.append(name)
        out.sort()
        return out

    def mount_for(self, path: str) -> MountEntry:
        """Find the mount that handles this path."""
        norm = "/" + path.strip("/")
        for m in self._mounts:
            if (norm == m.prefix.rstrip("/") or norm.startswith(m.prefix)):
                return m
        raise ValueError(f"no mount matches path: {path!r}")

    def is_exec_allowed(self) -> bool:
        for m in self._mounts:
            if m.prefix == DEV_PREFIX:
                continue
            if m.effective_mode() == MountMode.EXEC:
                return True
        return False

    def mount_for_command(self, cmd_name: str) -> MountEntry | None:
        """Find a mount that has this command registered.

        Prefers the virtual root mount, then searches other mounts.
        """
        if (self._root is not None
                and self._root.resolve_command(cmd_name) is not None):
            return self._root
        for m in self._mounts:
            if m.resolve_command(cmd_name) is not None:
                return m
        return None

    async def resolve_mount(
        self,
        cmd_name: str,
        path_scopes: list[PathSpec],
        cwd: str,
    ) -> MountEntry | None:
        """Resolve which mount should handle a command.

        Resolution order:
        1. First PathSpec path (or cwd) → mount_for(path)
        2. If mount lacks the command → mount_for_command(cmd_name)
        3. For a read-only command on a caching backend under ALWAYS
           consistency, evict stale entries from the hidden file cache so
           the in-place read-through serves fresh bytes. The command always
           stays on its real mount; the cache is never a mount.

        Args:
            cmd_name (str): command name.
            path_scopes (list[PathSpec]): path arguments.
            cwd (str): current working directory.
        """
        if path_scopes:
            mount_path = path_scopes[0].virtual
        else:
            mount_path = cwd

        try:
            mount = self.mount_for(mount_path)
        except ValueError:
            mount = None

        if mount is not None and mount.resolve_command(cmd_name) is None:
            if path_scopes:
                raise MountCommandUnsupported(cmd_name, mount.resource.name,
                                              path_scopes[0].raw_path)
            mount = self.mount_for_command(cmd_name)
        elif mount is None:
            mount = self.mount_for_command(cmd_name)

        if mount is None:
            return None

        resolved = mount.resolve_command(cmd_name)
        # Warm reads are served in place by with_read_cache, so a read-only
        # command stays on its real mount. Single-mount reads do not go
        # through the dispatcher, so this is where they reconcile against
        # backend truth: the shared Reconciler evicts a stale cache entry and
        # GCs an orphaned overlay when the backend reports the path gone.
        if (self._reconciler is not None and path_scopes
                and resolved is not None and not resolved.write
                and mount.resource.caches_reads
                and self._consistency == ConsistencyPolicy.ALWAYS):
            for scope in path_scopes:
                await self._reconciler.reconcile_read(mount, scope.virtual)

        return mount

    @property
    def root_mount(self) -> MountEntry | None:
        return self._root

    @property
    def file_cache(self) -> FileCacheMixin | None:
        return self._file_cache

    def mounts(self) -> list[MountEntry]:
        return list(self._mounts)

    def ops_mounts(self) -> list[OpsMount]:
        """Build OpsMount list from registered mounts for Ops layer."""
        return [
            OpsMount(
                prefix=m.prefix,
                resource_type=m.resource.name,
                accessor=m.resource.accessor,
                index=m.resource.index,
                mode=m.mode,
                ops=m.resource.ops_list(),
            ) for m in self._mounts
        ]

    def find_resource_by_name(
        self,
        resource_name: str | None,
    ) -> BaseResource | None:
        """Find a resource by its type name."""
        if resource_name is None:
            return None
        for mount in self._mounts:
            if mount.resource.name == resource_name:
                return mount.resource
        return None

    def get_resource_type(
        self,
        path: str | None,
    ) -> str | None:
        """Get the resource type for a virtual path."""
        if path is None:
            return None
        try:
            resource, _, _ = self.resolve(path)
            return resource.name
        except (ValueError, KeyError):
            return None

    def group_by_mount(
        self,
        paths: list[str],
    ) -> list[tuple[MountEntry, list[str]]]:
        """Group virtual paths by their mount.

        Returns list of (mount, resource_paths).
        """
        groups: dict[int, tuple[MountEntry, list[str]]] = {}
        for path in paths:
            mount = self.mount_for(path)
            _, resource_path, _ = self.resolve(path)
            key = id(mount)
            if key not in groups:
                groups[key] = (mount, [])
            groups[key][1].append(resource_path)
        return list(groups.values())
