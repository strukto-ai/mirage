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

from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.general import COMMANDS as GENERAL_COMMANDS
from mirage.ops.config import OpsMount
from mirage.resource.base import BaseResource
from mirage.resource.dev import DevResource
from mirage.types import ConsistencyPolicy, MountMode, PathSpec
from mirage.workspace.mount.mount import Mount

DEV_PREFIX = "/dev/"


class MountRegistry:
    """Longest-prefix-match router.

    Given a virtual path like "/s3-prod/data/file.json",
    resolves to the mount at "/s3-prod/" and returns the
    stripped resource path "/data/file.json".
    """

    def __init__(self) -> None:
        self._mounts: list[Mount] = []
        self._default_mount: Mount | None = None
        self._consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY
        self._file_cache: FileCacheMixin | None = None
        self.mount(DEV_PREFIX, DevResource(), MountMode.WRITE)

    def set_consistency(self, consistency: ConsistencyPolicy) -> None:
        self._consistency = consistency

    def attach_file_cache(self, cache: FileCacheMixin | None) -> None:
        """Attach the workspace file cache and build per-mount
        CacheManagers.

        Called once by Workspace after the cache store exists. Mounts
        added later get their manager in ``mount()`` /
        ``set_default_mount()``.

        Args:
            cache (FileCacheMixin | None): Workspace file cache store.
        """
        self._file_cache = cache
        for m in self._mounts:
            self._attach_manager(m)
        if self._default_mount is not None:
            self._attach_manager(self._default_mount)

    def _attach_manager(self, m: Mount) -> None:
        m.cache_manager = CacheManager(self._file_cache, m.resource.index,
                                       m.prefix, m.resource.is_remote is True)

    def set_default_mount(self, resource: BaseResource) -> None:
        """Set a default fallback mount (cache resource).

        Used when a command has no path args and cwd
        doesn't match any mount.
        """
        m = Mount("/_default/", resource, MountMode.WRITE)
        for cmd in resource.commands():
            m.register(cmd)
        for cmd in GENERAL_COMMANDS:
            m.register_general(cmd)
        for ro in resource.ops_list():
            m.register_op(ro)
        if self._file_cache is not None:
            self._attach_manager(m)
        self._default_mount = m

    def mount(
        self,
        prefix: str,
        resource: BaseResource,
        mode: MountMode = MountMode.READ,
        consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY,
    ) -> Mount:
        """Mount a resource and return the Mount object."""
        stripped = prefix.strip("/")
        norm_prefix = ("/" + stripped + "/" if stripped else "/")
        for existing in self._mounts:
            if existing.prefix == norm_prefix:
                raise ValueError(f"duplicate mount prefix: "
                                 f"{norm_prefix!r}")
        m = Mount(norm_prefix, resource, mode, consistency)
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
        return m

    def unmount(self, prefix: str) -> Mount:
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

    def mount_for_prefix(self, prefix: str) -> Mount:
        for m in self._mounts:
            if m.prefix == prefix:
                return m
        raise ValueError(f"no mount with prefix {prefix!r}")

    def is_mount_root(self, path: str) -> bool:
        stripped = path.strip("/")
        norm = "/" + stripped + "/" if stripped else "/"
        return any(m.prefix == norm for m in self._mounts)

    def descendant_mounts(self, path: str) -> list[Mount]:
        """Mounts whose prefix is strictly under `path`.

        Used by traversal commands (find, tree, du, grep -r) to fan out
        across nested mounts. Excludes the mount that contains `path`
        itself; callers should add that mount via `mount_for(path)`.

        Args:
            path (str): parent path to scan beneath.
        """
        stripped = path.strip("/")
        norm = "/" + stripped + "/" if stripped else "/"
        out: list[Mount] = []
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

    def mount_for(self, path: str) -> Mount:
        """Find the mount that handles this path."""
        norm = "/" + path.strip("/")
        for m in self._mounts:
            if (norm == m.prefix.rstrip("/") or norm.startswith(m.prefix)):
                return m
        raise ValueError(f"no mount matches path: {path!r}")

    def is_exec_allowed(self) -> bool:
        for m in self._mounts:
            prefix_no_trail = m.prefix.rstrip("/") or "/"
            if prefix_no_trail == "/":
                return m.mode == MountMode.EXEC
        for m in self._mounts:
            if m.prefix == DEV_PREFIX:
                continue
            if m.mode == MountMode.EXEC:
                return True
        return False

    def mount_for_command(self, cmd_name: str) -> Mount | None:
        """Find a mount that has this command registered.

        Prefers the default mount (cache resource), then
        searches other mounts.
        """
        if (self._default_mount is not None
                and self._default_mount.resolve_command(cmd_name) is not None):
            return self._default_mount
        for m in self._mounts:
            if m.resolve_command(cmd_name) is not None:
                return m
        return None

    async def resolve_mount(
        self,
        cmd_name: str,
        path_scopes: list[PathSpec],
        cwd: str,
    ) -> Mount | None:
        """Resolve which mount should handle a command.

        Resolution order:
        1. First PathSpec path (or cwd) → mount_for(path)
        2. If mount lacks the command → mount_for_command(cmd_name)
        3. If a read-only command's paths are all cached → use cache
           mount instead. Write commands always stay on the real mount
           so mutations reach the backend rather than just the cache.

        Args:
            cmd_name (str): command name.
            path_scopes (list[PathSpec]): path arguments.
            cwd (str): current working directory.
        """
        if path_scopes:
            mount_path = path_scopes[0].original
        else:
            mount_path = cwd

        try:
            mount = self.mount_for(mount_path)
        except ValueError:
            mount = None

        if mount is None or mount.resolve_command(cmd_name) is None:
            mount = self.mount_for_command(cmd_name)

        if mount is None:
            return None

        default = self._default_mount
        resolved = mount.resolve_command(cmd_name)
        if (default is not None and path_scopes and resolved is not None
                and not resolved.write
                and isinstance(default.resource, FileCacheMixin)
                and mount.resource.is_remote is True):
            keys = [p.original for p in path_scopes]
            if self._consistency == ConsistencyPolicy.ALWAYS:
                await self._evict_stale(mount, default.resource, path_scopes)
            if await default.resource.all_cached(keys):
                mount = default

        return mount

    async def _evict_stale(
        self,
        real_mount: Mount,
        cache: FileCacheMixin,
        path_scopes: list[PathSpec],
    ) -> None:
        """Evict cached entries whose remote fingerprint has changed.

        Only used when ConsistencyPolicy.ALWAYS is active. Backends that
        return stat.fingerprint=None silently fall back to LAZY behavior
        (no eviction, cache serves whatever it has).
        """
        for scope in path_scopes:
            key = scope.original
            if not await cache.exists(key):
                continue
            try:
                remote_stat = await real_mount.execute_op("stat", key)
            except FileNotFoundError:
                await cache.remove(key)
                continue
            except Exception:
                continue
            if remote_stat is None or remote_stat.fingerprint is None:
                continue
            if not await cache.is_fresh(key, remote_stat.fingerprint):
                await cache.remove(key)

    @property
    def default_mount(self) -> Mount | None:
        return self._default_mount

    def mounts(self) -> list[Mount]:
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
    ) -> list[tuple[Mount, list[str]]]:
        """Group virtual paths by their mount.

        Returns list of (mount, resource_paths).
        """
        groups: dict[int, tuple[Mount, list[str]]] = {}
        for path in paths:
            mount = self.mount_for(path)
            _, resource_path, _ = self.resolve(path)
            key = id(mount)
            if key not in groups:
                groups[key] = (mount, [])
            groups[key][1].append(resource_path)
        return list(groups.values())
