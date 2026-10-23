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
from collections.abc import Awaitable, Callable
from typing import Any, Protocol
from weakref import WeakValueDictionary

from mirage.accessor.base import Accessor
from mirage.cache.file.io import mutation_lock
from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexConfig
from mirage.cache.index.config import Evicted
from mirage.cache.index.factory import build_index
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.general import COMMANDS as GENERAL_COMMANDS
from mirage.commands.builtin.generic_bind.factory import GENERIC_COMMANDS
from mirage.context import (
    effective_path_mode,
    strongest_mode_under,
)
from mirage.errors.fs import no_mount
from mirage.errors.types import NoMountError
from mirage.io.config import IOConfig
from mirage.observe.observer import Observer
from mirage.policy import Decisions, MountRootPolicy, Policies
from mirage.process.view import ProcessView
from mirage.rs.diff_types import DiffComputer
from mirage.runtime.base import Runtime
from mirage.runtime.types import DispatchFn
from mirage.types import (
    Limit,
    MountMode,
    PathSpec,
    ReadSpec,
    WritePolicy,
)
from mirage.utils.clock import Clock, SystemClock
from mirage.utils.ids import IdSource, SystemIdSource
from mirage.utils.path import norm_dir, owner_prefix
from mirage.vfs.base import BaseVFS
from mirage.vfs.dev import DevVFS
from mirage.workspace.cli import CLIRegistry
from mirage.workspace.mount.backends import backend_commands
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.session.session import SessionState
from mirage.workspace.types import MountRow

DEV_PREFIX = "/dev/"


class ReadReconciler(Protocol):
    """What the registry needs from a reconciler.

    Depending on this local interface (not the concrete ``Reconciler``)
    keeps the dependency pointing down: ``reconcile`` imports the mount
    layer, not the other way round. The Reconciler satisfies it structurally.
    """

    async def on_gone(
        self, gone: list[Evicted], excluded: tuple[str, ...] = ()
    ) -> None: ...

    async def may_serve_listing(
        self, mount: MountEntry, folder: str, version: str | None
    ) -> bool: ...


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

    Args:
        io (IOConfig | None): the workspace's IO knobs; None keeps the
            defaults.
        clock (Clock | None): the clock every index store this registry
            builds reads time through; None means the system clock.
        ids (IdSource | None): where the mounts this registry places
            and the commands it runs draw generated ids and random
            values; None means the system source.
    """

    def __init__(
        self,
        io: IOConfig | None = None,
        clock: Clock | None = None,
        ids: IdSource | None = None,
    ) -> None:
        self.io = io if io is not None else IOConfig()
        self.clock: Clock = clock if clock is not None else SystemClock()
        self.ids: IdSource = ids if ids is not None else SystemIdSource()
        # Scopes the redis index stores this registry builds; the
        # workspace sets it.
        self.workspace_id: str | None = None
        self.process_view: Callable[[SessionState], ProcessView] | None = None
        # Fetches the managed names a tree a mount serves reads, once the
        # executor has picked that mount; the workspace sets it.
        self.fill_env: (
            Callable[[SessionState, frozenset[str]], Awaitable[None]] | None
        ) = None
        self.observer: Observer | None = None
        self.diff: DiffComputer | None = None
        self._mounts: list[MountEntry] = []
        # ``mount_rows`` as last built; a mount, an unmount or the
        # anchor changing clears it.
        self._rows: list[MountRow] | None = None
        self.retiring_mounts: dict[int, asyncio.Task[None]] = {}
        self.retired_mounts: WeakValueDictionary[int, BaseVFS] = (
            WeakValueDictionary()
        )
        self._root: MountEntry | None = None
        # The root the workspace adds when no mount claims `/`.
        self._anchor: MountEntry | None = None
        # Workspace-level command -> runtime bindings (first listed
        # capturer wins). The two runtime fields below are written
        # only by the workspace's Runtimes, on construction and on every
        # add_runtime/remove_runtime. The dispatcher injects the
        # bound runtime only for commands that have one, so it cannot
        # tell python3 from grep.
        self.runtime_bindings: dict[str, Runtime[Any]] = {}
        # The ordered runtime world. The CLI script arm
        # selects an interpreter from it (a runtime: pin or the
        # script's language), which the bindings dict cannot answer:
        # an entry behind another capturer never binds a command.
        self.runtime_entries: list[Runtime[Any]] = []
        self.command_limits: dict[str, Limit] = {}
        # Why a command that SOME runtime class captures has no live
        # binding: default-world entries that failed to build (missing
        # extra) record their construction error per captured command,
        # so the refusal at dispatch carries the install hint without
        # any command naming a runtime class.
        self.runtime_unavailable: dict[str, str] = {}
        # Command admission policies. Policies itself is a bare
        # mechanism; the registry seeds the POSIX mount-root rule
        # (mount-root semantics are mount semantics), and user policies
        # follow it (the document's deny rules, then Workspace policies=).
        # Registry-hosted like runtime_bindings so the executor reaches
        # them without new parameter threading.
        self.policies = Policies([MountRootPolicy(self)])

        # Installed CLIs. Not mount state: CLIs are fully separate from
        # mounts (a CLI exists because it was installed, never because
        # storage was mounted). The registry object is just the vehicle
        # that already reaches every dispatch site, same as the
        # runtime fields above.
        self.clis = CLIRegistry(lambda: [m.vfs.accessor for m in self._mounts])
        # The workspace-level default a mount overrides, kept so the
        # runtime entry point (`Workspace.add_mount`) has something to resolve
        # an unset policy against.
        self._default_read: ReadSpec = ReadSpec()
        self._default_write: WritePolicy = WritePolicy.UNCONDITIONAL
        self._file_cache: FileCacheMixin | None = None
        self._reconciler: ReadReconciler | None = None
        self._dispatch: DispatchFn | None = None
        # Explicit at the construction site: /dev does not cache reads,
        # so its policy can only ever be bounded, and it keeps no index,
        # since a path-only index would expose one session's descriptors
        # to another.
        self.mount(
            DEV_PREFIX,
            DevVFS(),
            MountMode.WRITE,
            ReadSpec(),
            write=WritePolicy.UNCONDITIONAL,
            store=NULL_INDEX,
        )

    async def drop_caches(self, by: Accessor | None = None) -> None:
        """Drop what a write past the dispatcher may have made stale.

        Native code (an external program, a remote runtime line) or an
        account CLI changed its service with no path the dispatcher saw,
        so per-path invalidation has nothing to aim at: after `gws sheets
        spreadsheets create` the new file has no cache entry to expire,
        which is exactly the case that matters. Every mount the write may
        have reached drops what it keeps (``MountEntry.drop_caches``). A
        write verb is rare next to reads, and the cost is one cold listing
        on a mount's next read, never a wrong answer.

        Args:
            by (Accessor | None): the client that wrote, whose ``reaches``
                names the mounts it may have changed; None for every mount.
        """
        mounts = self.mounts()
        reached = [
            m for m in mounts if by is None or by.reaches(m.vfs.accessor)
        ]
        cache = self._file_cache
        # Every mount: one clear of the file cache, not a scan per mount.
        every = cache is not None and len(reached) == len(mounts)
        if every and cache is not None:
            # Under the lock a fill checks its read generation with, so a
            # read begun before the write keeps nothing on any mount, as
            # each mount's own drop retires and evicts in one step.
            async with mutation_lock(cache):
                for mount in reached:
                    if mount.cache_manager is not None:
                        mount.cache_manager.retire()
                await cache.clear()
        for mount in reached:
            await mount.drop_caches(bodies=not every)

    async def settle(self, runtime: Runtime[Any]) -> None:
        """Land a runtime's writes when its line ends, however it ended,
        and drop the caches when they went past the dispatcher.

        A runtime serving the workspace over SFTP sent each write through
        the dispatcher, which invalidated that path as it went
        (``file_effects_dispatched``). Any other may have written anywhere
        in its view of the workspace, so every mount drops its caches and
        the next command refetches instead of serving pre-line state.

        Example: `cat /data/x` caches "old"; `python3 job.py` runs in a
        sandbox and writes "new" straight to S3 through its own FUSE
        mount, which the dispatcher never saw; without the drop the next
        `cat /data/x` would serve the stale "old".

        Args:
            runtime (Runtime): the runtime the line ran on.
        """
        await runtime.settle()
        if not runtime.file_effects_dispatched:
            await self.drop_caches()

    def set_default_read(self, read: ReadSpec) -> None:
        """Install the workspace-level read policy a mount overrides.

        Args:
            read (ReadSpec): the default for mounts that declare none.
        """
        self._default_read = read

    def set_default_write(self, write: WritePolicy) -> None:
        """Install the workspace-level write policy a mount overrides.

        Args:
            write (WritePolicy): the default for mounts that declare none.
        """
        self._default_write = write

    def set_reconciler(self, reconciler: ReadReconciler) -> None:
        self._reconciler = reconciler

    @property
    def dispatch(self) -> DispatchFn | None:
        """The workspace's dispatcher, which a shell glob lists and stats
        through; None until the workspace wires it in, and for a bare
        registry with no workspace behind it."""
        return self._dispatch

    def set_dispatch(self, dispatch: DispatchFn) -> None:
        """Wire in the workspace's dispatcher.

        Args:
            dispatch (DispatchFn): the dispatcher's ``dispatch``.
        """
        self._dispatch = dispatch

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

    async def _may_serve_listing(
        self, m: MountEntry, folder: str, version: str | None
    ) -> bool:
        """Run the shared listing verdict for one mount's cached listing.

        The reconciler is read at call time because ``attach_file_cache``
        runs before ``set_reconciler``, and a manager with none trusts its
        listings. A retiring mount answers False without asking, and EBUSY
        from a mount that began retiring mid-check answers False too.

        Args:
            m (MountEntry): the mount whose listing is in question.
            folder (str): mount-absolute listing key.
            version (str | None): the version stored with the listing.
        """
        reconciler = self._reconciler
        if reconciler is None:
            return True
        if m.retiring:
            return False
        try:
            return await reconciler.may_serve_listing(m, folder, version)
        except OSError as exc:
            if exc.errno != errno.EBUSY:
                raise
            return False

    def _attach_manager(self, m: MountEntry) -> None:
        async def listing_gate(folder: str, version: str | None) -> bool:
            return await self._may_serve_listing(m, folder, version)

        async def cleanup(gone: list[Evicted]) -> None:
            # Read at call time, as the listing gate is; a retiring
            # mount's leftovers go with its teardown instead.
            reconciler = self._reconciler
            if reconciler is not None and not m.retiring:
                await reconciler.on_gone(
                    gone,
                    tuple(
                        e.prefix.rstrip("/")
                        for e in self.descendant_mounts(m.prefix)
                    ),
                )

        m.cache_manager = CacheManager(
            self._file_cache,
            m.index_store,
            m.prefix,
            m.vfs.caches_reads,
            lambda path: not m.retiring and self.try_mount_for(path) is m,
            read_ttl=m.read.ttl,
            on_gone=cleanup,
            may_serve_listing=listing_gate,
            excluded_prefixes=lambda: tuple(
                e.prefix.rstrip("/") for e in self.descendant_mounts(m.prefix)
            ),
            aliases=lambda: tuple(
                e.cache_manager
                for e in self._mounts
                if e is not m
                and e.vfs is m.vfs
                and e.cache_manager is not None
            ),
        )

    def check_vfs_available(self, vfs: BaseVFS) -> None:
        """A removed VFS instance cannot start a second lifecycle."""
        if id(vfs) in self.retiring_mounts or any(
            m.vfs is vfs and m.retiring for m in self._mounts
        ):
            raise ValueError("VFS is being unmounted")
        if vfs.is_closed or self.retired_mounts.get(id(vfs)) is vfs:
            raise ValueError("VFS is closed; create a new VFS instance")

    def mount(
        self,
        prefix: str,
        vfs: BaseVFS,
        mode: MountMode = MountMode.READ,
        read: ReadSpec | None = None,
        *,
        write: WritePolicy | None = None,
        index: IndexConfig | None = None,
        vfs_ref: str | None = None,
        store: IndexCacheStore | None = None,
    ) -> MountEntry:
        """Place a VFS and return its mount.

        The mount is built with everything the tree needs to run the
        driver: its index store (shared with any earlier mount of the
        same instance, else ``store``, else built from ``index`` or the
        driver's ``index_ttl``), the driver's op and command tables, and
        the reference it was built from.

        Args:
            prefix (str): the virtual prefix.
            vfs (BaseVFS): the driver.
            mode (MountMode): the mount's ceiling.
            read (ReadSpec | None): the mount's read policy; None takes
                the workspace default.
            write (WritePolicy | None): the mount's write policy; None
                takes the workspace default.
            index (IndexConfig | None): the index store to build; None
                takes a RAM store at the driver's ``index_ttl``.
            vfs_ref (str | None): the ``vfs:`` value the driver was
                built from, recorded for snapshots.
            store (IndexCacheStore | None): a store the placement
                supplies itself, as the reserved /dev mount does.
        """
        self.check_vfs_available(vfs)
        norm_prefix = norm_dir(prefix)
        for existing in self._mounts:
            if existing.prefix == norm_prefix:
                raise ValueError(f"duplicate mount prefix: {norm_prefix!r}")
        alias = next((e for e in self._mounts if e.vfs is vfs), None)
        if alias is not None:
            store = alias.index_store
            index = alias.index_config
        elif isinstance(vfs, DevVFS):
            store = NULL_INDEX
        elif store is None:
            store = build_index(
                index, vfs.index_ttl, self.clock, self.workspace_id
            )
        m = MountEntry(
            norm_prefix,
            vfs,
            mode,
            read if read is not None else self._default_read,
            store,
            vfs_ref,
            index,
            write if write is not None else self._default_write,
            self.ids,
        )
        if alias is not None:
            m.activity = alias.activity
        # The shared set first, so a command the VFS replaces keeps its own
        # spec, not the generic one of that name.
        for cmd in (*GENERIC_COMMANDS, *GENERAL_COMMANDS):
            m.register_general(cmd)
        # Mirage's own commands for the backend, then the ones the VFS was
        # handed, which are user commands and win.
        m._register_builtins(backend_commands(vfs))
        m.register_commands(vfs.commands())
        self._attach_manager(m)
        self._mounts.append(m)
        self._mounts.sort(key=lambda x: len(x.prefix), reverse=True)
        self._rows = None
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
        norm_prefix = norm_dir(prefix)
        if norm_prefix == DEV_PREFIX:
            raise ValueError(
                f"cannot unmount reserved prefix: {norm_prefix!r}"
            )
        for i, m in enumerate(self._mounts):
            if m.prefix == norm_prefix:
                del self._mounts[i]
                self._rows = None
                if m is self._root:
                    self._root = None
                if m is self._anchor:
                    self._anchor = None
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
        vfs_path = "/" + norm[len(m.prefix) :]
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

    def try_mount_for_prefix(
        self, prefix: str, *, include_hidden: bool = False
    ) -> MountEntry | None:
        """The mount at exactly this prefix, or None when none matches.

        The argument is normalized like ``mount``/``unmount`` take it, so
        the registration spelling ("/data", "data/") finds the stored
        "/data/" entry (mirrors the TS twin).
        """
        norm = norm_dir(prefix)
        for m in self._mounts if include_hidden else self.visible_mounts():
            if m.prefix == norm:
                return m
        return None

    def limit_override(self, prefix: str, name: str) -> Limit | None:
        """One mount's configured cap for a command or op name.

        The lookup a command's output guard resolves with; tolerant of a
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
        norm = norm_dir(path)
        out: list[MountEntry] = []
        for m in self.visible_mounts():
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
        owner = owner_prefix((m.prefix for m in self.visible_mounts()), path)
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
        file operand (``python3 path.py``, ``js app.js``, or a
        ``./script`` whose shebang names one). Shell scripts (``bash
        script.sh``, ``source``, a ``./script`` with no shebang or an sh
        one) never ask: they run in the shell, which checks each of
        their commands like a typed one.

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
        if (
            self._root is not None
            and self._root.resolve_command(cmd_name) is not None
        ):
            return self._root
        for m in self.visible_mounts():
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

    def command_mount(
        self,
        cmd_name: str,
        path_scopes: list[PathSpec],
        cwd: str,
    ) -> MountEntry | None:
        """The mount a command runs on, as ``resolve_mount`` picks it,
        without readying it.

        The mount of the first path operand, else of the working
        directory, when it registers the command; else the first mount
        that does. None where none does, or where the first operand's
        mount lacks it, a line ``resolve_mount`` refuses.

        Args:
            cmd_name (str): command name.
            path_scopes (list[PathSpec]): path arguments.
            cwd (str): current working directory.
        """
        mount = self.try_mount_for(
            path_scopes[0].virtual if path_scopes else cwd
        )
        if mount is not None and mount.resolve_command(cmd_name) is not None:
            return mount
        if mount is not None and path_scopes:
            return None
        return self.mount_for_command(cmd_name)

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

        The command always stays on its real mount; the cache is never a
        mount. Its operands meet backend truth at the dispatcher, the
        first time it stats or reads them.

        Args:
            cmd_name (str): command name.
            path_scopes (list[PathSpec]): path arguments.
            cwd (str): current working directory.
        """
        mount = self.command_mount(cmd_name, path_scopes, cwd)
        if mount is None and path_scopes:
            owner = self.try_mount_for(path_scopes[0].virtual)
            if owner is not None:
                raise MountCommandUnsupported(
                    cmd_name,
                    owner.vfs.name,
                    path_scopes[0].raw_path or path_scopes[0].virtual,
                )
        if mount is None:
            return None

        await mount.ensure_ready()
        return mount

    @property
    def root_mount(self) -> MountEntry | None:
        return self._root

    @property
    def decisions(self) -> Decisions:
        """The decision ledger an Ask is taken to, which the policies
        hold (``Policies.decisions``) so a session write reaches it too."""
        return self.policies.decisions

    def anchor_root(self, entry: MountEntry) -> None:
        """Mark `entry` as the root the workspace added, not one mounted.

        Args:
            entry (MountEntry): the scratch root ``install_mounts`` made
                because no mount claims ``/``.
        """
        self._anchor = entry
        self._rows = None

    @property
    def file_cache(self) -> FileCacheMixin | None:
        return self._file_cache

    def mounts(self) -> list[MountEntry]:
        return list(self._mounts)

    def visible_mounts(self) -> list[MountEntry]:
        return [
            m for m in self._mounts if m.visible is None or m.visible(None)
        ]

    def rows_changed(self) -> None:
        """Say a mount's row changed in place (its mode, who is told of
        it), so ``mount_rows`` builds afresh."""
        self._rows = None

    def mount_rows(self) -> list[MountRow]:
        """One row per registered mount, for the namespace reader the
        dispatcher hands out; built once per change to the table."""
        if self._rows is None:
            self._rows = self._built_rows()
        return list(self._rows)

    def _built_rows(self) -> list[MountRow]:
        """The rows ``mount_rows`` serves, built from the mount list."""
        return [
            MountRow(
                prefix=m.prefix,
                resource_type=m.vfs.name,
                mode=m.mode,
                sizes_always_known=m.vfs.sizes_always_known,
                anchor=m is self._anchor,
                visible=m.visible,
                max_du_entries=m.vfs.max_du_entries,
                max_glob_matches=m.vfs.max_glob_matches,
                searchable=m.vfs.searchable,
                calls=m.calls,
            )
            for m in self._mounts
        ]
