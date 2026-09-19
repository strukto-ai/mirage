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
import errno
from typing import Protocol
from weakref import WeakValueDictionary

from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.general import COMMANDS as GENERAL_COMMANDS
from mirage.context import effective_path_mode, strongest_mode_under
from mirage.ops.config import OpsMount
from mirage.policy import Decisions, MountRootPolicy, OutputCapPolicy, Policies
from mirage.runtime.base import Runtime
from mirage.runtime.table import WorkspaceRuntime
from mirage.types import ConsistencyPolicy, Limit, MountMode, PathSpec
from mirage.utils.errors import NoMountError, no_mount
from mirage.utils.path import owner_prefix
from mirage.vfs.base import BaseVFS
from mirage.vfs.dev import DevVFS
from mirage.workspace.cli import CLIRegistry
from mirage.workspace.mount.mount import MountEntry

DEV_PREFIX = "/dev/"


class ReadReconciler(Protocol):
    """What the registry needs from a reconciler.

    Depending on this local interface (not the concrete ``Reconciler``)
    keeps the dependency pointing down: ``reconcile`` imports the mount
    layer, not the other way round. The Reconciler satisfies it structurally.
    """

    async def reconcile_read(self,
                             mount: MountEntry,
                             path: str,
                             *,
                             cached_gated: bool = False) -> None:
        ...

    async def may_serve_cached(self, mount: MountEntry, path: str) -> bool:
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
    stripped VFS path "/data/file.json".
    """

    def __init__(self) -> None:
        self._mounts: list[MountEntry] = []
        self.retiring_mounts: dict[int, asyncio.Task[None]] = {}
        self.retired_mounts: WeakValueDictionary[int, BaseVFS] = (
            WeakValueDictionary())
        self._root: MountEntry | None = None
        # Workspace-level command -> runtime bindings (first listed
        # capturer wins), set by Workspace after construction (same
        # vehicle as is_exec_allowed()). The dispatcher injects the
        # bound runtime only for commands that have one, so it cannot
        # tell python3 from grep.
        self.runtime_bindings: dict[str, Runtime] = {}
        # The world's workspace runtime, set by Workspace after construction.
        # Catch-all when its captures are empty; explicit captures make
        # unclaimed commands an admission failure (126).
        self.workspace_runtime: WorkspaceRuntime | None = None
        # The ordered runtime world, set by Workspace after
        # construction and refreshed on add(). The CLI script arm
        # selects an interpreter from it (a runtime: pin or the
        # script's language), which the bindings dict cannot answer:
        # an entry behind another capturer never binds a command.
        self.runtime_entries: list[Runtime] = []
        # Why a command that SOME runtime class captures has no live
        # binding: default-world entries that failed to build (missing
        # extra) record their construction error per captured command,
        # so the refusal at dispatch carries the install hint without
        # any command naming a runtime class.
        self.runtime_unavailable: dict[str, str] = {}
        # Command admission policies. Policies itself is a bare
        # mechanism; the registry seeds the POSIX mount-root rule
        # (mount-root semantics are mount semantics) and the built-in
        # output cap (fed the per-mount overrides), and user policies
        # follow them (the document's deny rules, then Workspace policies=).
        # Registry-hosted like runtime_bindings so the executor reaches
        # them without new parameter threading.
        self.policies = Policies(
            [MountRootPolicy(),
             OutputCapPolicy(self.limit_override)])
        # The decision ledger the executor takes an Ask to, hosted here
        # for the same reason as the policies: the workspace replaces
        # it with one bound to its session manager and ask handler.
        self.decisions = Decisions()

        # Installed CLIs. Not mount state: CLIs are fully separate from
        # mounts (a CLI exists because it was installed, never because
        # storage was mounted). The registry object is just the vehicle
        # that already reaches every dispatch site, same as the
        # runtime fields above.
        self.clis = CLIRegistry()
        self._consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY
        self._file_cache: FileCacheMixin | None = None
        self._reconciler: ReadReconciler | None = None
        self.mount(DEV_PREFIX, DevVFS(), MountMode.WRITE)

    async def invalidate_after_external(self) -> None:
        """Refetch cached data after native code may have changed files."""
        if self._file_cache is not None:
            await self._file_cache.clear()
        for mount in self.mounts():
            if mount.cache_manager is not None:
                await mount.cache_manager.clear_index(mount.vfs.index)
            else:
                async with mount.use():
                    await mount.vfs.index.clear()

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

    async def _may_serve_cached(self, m: MountEntry, key: str) -> bool:
        """Run the shared read verdict for one mount's cached entry.

        The file cache's door and the dispatcher's door ask the same
        question, so they ask the same function; a second verdict rule here
        is what let the two drift apart in the first place. The reconciler
        is read at call time because ``attach_file_cache`` runs before
        ``set_reconciler``, and a manager with none trusts its cache.

        A retiring mount answers False rather than probing: ``execute_op``
        raises EBUSY once teardown has started, and ``owns_path`` cannot
        catch that on its own because it is read before several awaits.
        False sends the caller to a cold read, which is exactly where
        ``owns_path`` already sends it today.

        Args:
            m (MountEntry): the mount whose cache entry is in question.
            key (str): mount-absolute cache key.
        """
        reconciler = self._reconciler
        if reconciler is None:
            return True
        if m.retiring:
            return False
        try:
            return await reconciler.may_serve_cached(m, key)
        except OSError as exc:
            if exc.errno != errno.EBUSY:
                raise
            return False

    def _attach_manager(self, m: MountEntry) -> None:

        async def gate(key: str) -> bool:
            return await self._may_serve_cached(m, key)

        m.cache_manager = CacheManager(
            self._file_cache, m.vfs.index, m.prefix, m.vfs.caches_reads,
            lambda path: not m.retiring and self.try_mount_for(path) is m,
            gate)

    def check_vfs_available(self, vfs: BaseVFS) -> None:
        """A removed VFS instance cannot start a second lifecycle."""
        if id(vfs) in self.retiring_mounts or any(m.vfs is vfs and m.retiring
                                                  for m in self._mounts):
            raise ValueError("VFS is being unmounted")
        if (vfs.is_closed or self.retired_mounts.get(id(vfs)) is vfs):
            raise ValueError("VFS is closed; create a new VFS instance")

    def mount(
        self,
        prefix: str,
        vfs: BaseVFS,
        mode: MountMode = MountMode.READ,
        consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY,
    ) -> MountEntry:
        """Mount a VFS and return the Mount object."""
        self.check_vfs_available(vfs)
        stripped = prefix.strip("/")
        norm_prefix = ("/" + stripped + "/" if stripped else "/")
        for existing in self._mounts:
            if existing.prefix == norm_prefix:
                raise ValueError(f"duplicate mount prefix: "
                                 f"{norm_prefix!r}")
        m = MountEntry(norm_prefix, vfs, mode, consistency)
        for existing in self._mounts:
            if existing.vfs is vfs:
                m.activity = existing.activity
                break
        for cmd in vfs.commands():
            m.register(cmd)
        for cmd in GENERAL_COMMANDS:
            m.register_general(cmd)
        for ro in vfs.ops_list():
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
    ) -> tuple[BaseVFS, str, MountMode]:
        """Returns (VFS, vfs_path, mode)."""
        m = self.mount_for(path)
        had_trailing = path.endswith("/")
        norm = "/" + path.strip("/")
        vfs_path = "/" + norm[len(m.prefix):]
        if had_trailing and not vfs_path.endswith("/"):
            vfs_path += "/"
        return m.vfs, vfs_path, m.mode

    def mount_for_prefix(self, prefix: str) -> MountEntry:
        """The mount at exactly this prefix; raises NoMountError for none.

        Callers that expect the miss branch on ``try_mount_for_prefix``
        returning None instead of catching.
        """
        m = self.try_mount_for_prefix(prefix)
        if m is None:
            raise NoMountError(f"no mount with prefix {prefix!r}")
        return m

    def try_mount_for_prefix(self, prefix: str) -> MountEntry | None:
        """The mount at exactly this prefix, or None when none matches.

        The argument is normalized like ``mount``/``unmount`` take it, so
        the registration spelling ("/data", "data/") finds the stored
        "/data/" entry (mirrors the TS twin).
        """
        stripped = prefix.strip("/")
        norm = "/" + stripped + "/" if stripped else "/"
        for m in self._mounts:
            if m.prefix == norm:
                return m
        return None

    def limit_override(self, prefix: str, name: str) -> Limit | None:
        """One mount's configured cap for a command or op name.

        The lookup OutputCapPolicy is seeded with; tolerant of a
        prefix that matches no mount (unmounted between stamp and
        boundary) by answering None.

        Args:
            prefix (str): the mount prefix as stamped at dispatch.
            name (str): command or op name.
        """
        for m in self._mounts:
            if m.prefix == prefix or m.prefix.rstrip("/") == prefix:
                return m.command_limits.get(name)
        return None

    def is_mount_root(self, path: str) -> bool:
        return self.try_mount_for_prefix(path) is not None

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

    def mount_for(self, path: str) -> MountEntry:
        """The mount that handles this path; raises NoMountError for none.

        The lookup contract pair: ``mount_for`` is for callers whose path
        must be mounted (a miss is a broken invariant and propagates as a
        typed NoMountError), ``try_mount_for`` is for callers with a real
        fallback for the miss. Never catch around this method — call the
        try variant instead.
        """
        m = self.try_mount_for(path)
        if m is None:
            raise no_mount(path)
        return m

    def try_mount_for(self, path: str) -> MountEntry | None:
        """The mount that handles this path, or None when none does."""
        owner = owner_prefix((m.prefix for m in self._mounts), path)
        if owner is None:
            return None
        return self.try_mount_for_prefix(owner)

    def is_exec_allowed(self) -> bool:
        for m in self._mounts:
            if m.prefix == DEV_PREFIX:
                continue
            # strongest_mode_under, not effective_mode: a session whose
            # only x grant is a show entry still counts as having one.
            if strongest_mode_under(m.prefix, m.mode) == MountMode.EXEC:
                return True
        return False

    def exec_allowed_at(self, virtual: str) -> bool:
        """Whether code may be loaded from this path: the per-script
        form of ``is_exec_allowed``, read by an interpreter running a
        file operand (``python3 path.py``, ``bash script.sh``).

        Args:
            virtual (str): the script's absolute virtual path.
        """
        m = self.try_mount_for(virtual)
        if m is None:
            return False
        return effective_path_mode(virtual, m.prefix, m.mode) == MountMode.EXEC

    def mount_for_command(self, cmd_name: str) -> MountEntry | None:
        """Find a mount that has this command registered.

        Prefers the virtual root mount, then searches other mounts. The
        /dev/ mount never claims a command: it carries the general set
        like every mount, and letting it win would route pathless
        commands to the device mount (mirrors the TS scan).
        """
        if (self._root is not None
                and self._root.resolve_command(cmd_name) is not None):
            return self._root
        for m in self._mounts:
            if m.prefix == DEV_PREFIX:
                continue
            if m.resolve_command(cmd_name) is not None:
                return m
        return None

    def match_command_prefix(self, words: list[str]) -> int:
        """How many leading words form a registered command name.

        Command names may span several words (``gws docs documents
        get``), git-style. A nested name resolves from anywhere its
        owning mount is reachable, so this scans every mount (mirroring
        ``mount_for_command``) and returns the longest prefix any mount
        recognises, or 1 (bare first token) when none does.

        Args:
            words (list[str]): expanded leading words of a command line.
        """
        if not words:
            return 0
        # An installed CLI head wins over any multiword mount command
        # under the same first word (`himalaya message send`): dispatch
        # is by name and the subcommand words belong to the tree walk,
        # so the head alone is the command name.
        if self.clis.get(words[0]) is not None:
            return 1
        best = 1
        candidates = list(self._mounts)
        if self._root is not None:
            candidates.append(self._root)
        for mount in candidates:
            best = max(best, mount.longest_command_match(words))
        return best

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

        mount = self.try_mount_for(mount_path)

        if mount is not None and mount.resolve_command(cmd_name) is None:
            if path_scopes:
                raise MountCommandUnsupported(
                    cmd_name, mount.vfs.name, path_scopes[0].raw_path
                    or path_scopes[0].virtual)
            mount = self.mount_for_command(cmd_name)
        elif mount is None:
            mount = self.mount_for_command(cmd_name)

        if mount is None:
            return None

        await mount.ensure_ready()
        resolved = mount.resolve_command(cmd_name)
        # Warm reads are served in place by with_read_cache, so a read-only
        # command stays on its real mount. Single-mount reads do not go
        # through the dispatcher, so this is where they reconcile against
        # backend truth: the shared Reconciler evicts a stale cache entry and
        # GCs an orphaned overlay when the backend reports the path gone.
        if (self._reconciler is not None and path_scopes
                and resolved is not None and not resolved.write
                and mount.vfs.caches_reads
                and self._consistency == ConsistencyPolicy.ALWAYS):
            # A gated command probes each operand at the gate, so probing
            # here too would stat twice for one warm read. The orphaned
            # overlay is the part the gate never sees.
            for scope in path_scopes:
                await self._reconciler.reconcile_read(
                    mount, scope.virtual, cached_gated=resolved.read)

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
                resource_type=m.vfs.name,
                accessor=m.vfs.accessor,
                index=m.vfs.index,
                mode=m.mode,
                ops=m.vfs.ops_list(),
                sizes_always_known=m.vfs.SIZES_ALWAYS_KNOWN,
            ) for m in self._mounts
        ]

    def find_vfs_by_name(
        self,
        vfs_name: str | None,
    ) -> BaseVFS | None:
        """Find a VFS by its type name."""
        if vfs_name is None:
            return None
        for mount in self._mounts:
            if mount.vfs.name == vfs_name:
                return mount.vfs
        return None

    def get_resource_type(
        self,
        path: str | None,
    ) -> str | None:
        """Get the VFS type for a virtual path."""
        if path is None:
            return None
        try:
            vfs, _, _ = self.resolve(path)
            return vfs.name
        except NoMountError:
            return None

    def group_by_mount(
        self,
        paths: list[str],
    ) -> list[tuple[MountEntry, list[str]]]:
        """Group virtual paths by their mount.

        Returns list of (mount, vfs_paths).
        """
        groups: dict[int, tuple[MountEntry, list[str]]] = {}
        for path in paths:
            mount = self.mount_for(path)
            _, vfs_path, _ = self.resolve(path)
            key = id(mount)
            if key not in groups:
                groups[key] = (mount, [])
            groups[key][1].append(vfs_path)
        return list(groups.values())
