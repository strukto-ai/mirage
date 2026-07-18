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
import builtins
import logging
import sys
import time
from collections.abc import Iterable, Mapping
from functools import partial
from types import TracebackType
from typing import Any, Literal, TypeAlias, cast, overload

from mirage.bridge.sync import run_async_from_sync
from mirage.cache.file.config import CacheConfig, RedisCacheConfig
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index import IndexConfig
from mirage.commands.builtin.utils.safeguard import (CommandTimeoutError,
                                                     run_with_timeout)
from mirage.commands.errors import FindParseError, UsageError
from mirage.commands.safeguard import CommandSafeguard, resolve_safeguard
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.observe.context import RecordingScope
from mirage.observe.observer import Observer
from mirage.observe.record import OpRecord
from mirage.observe.store import ObserverStore
from mirage.ops import Ops
from mirage.ops.open import make_open
from mirage.ops.os_patch import make_os_module
from mirage.provision import ProvisionResult
from mirage.resource.base import BaseResource
from mirage.resource.history import HISTORY_PREFIX, HistoryViewResource
from mirage.resource.ram import RAMResource
from mirage.runtime.base import Runtime
from mirage.runtime.table import (DEFAULT_ENTRIES, VFS_ENTRY, bind_commands,
                                  build_runtime)
from mirage.shell.job_table import JobTable
from mirage.shell.parse import find_syntax_error, parse
from mirage.types import (ConsistencyPolicy, DriftPolicy, FileStat, MountMode,
                          PathSpec, StateKey, parse_mount_mode)
from mirage.utils.errors import format_fs_error
from mirage.utils.ids import new_session_id, new_workspace_id
from mirage.workspace.abort import MirageAbortError
from mirage.workspace.dispatcher import Dispatcher
from mirage.workspace.file_prompt import build_file_prompt
from mirage.workspace.fuse import FuseManager
from mirage.workspace.mount import MountEntry, MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.namespace.overlay import merge_overlay_stat
from mirage.workspace.mount.namespace.store import NamespaceStore
from mirage.workspace.mount.spec import Mount
from mirage.workspace.node import provision_node, run_command_tree
from mirage.workspace.session import (Session, SessionManager, SessionStore,
                                      reset_current_session,
                                      set_current_session)
from mirage.workspace.snapshot import (ContentDriftError, apply_state_dict,
                                       build_mount_args, check_drift,
                                       install_fingerprints, norm_mount_prefix,
                                       read_tar, requires_resource_override)
from mirage.workspace.snapshot import snapshot as _write_snapshot
from mirage.workspace.snapshot import to_state_dict
from mirage.workspace.store import RAMWorkspaceStateStore, WorkspaceStateStore

RedisFileCacheStore: Any
try:
    from mirage.cache.file.redis import \
        RedisFileCacheStore as _RedisFileCacheStore
except ImportError:
    RedisFileCacheStore = None
else:
    RedisFileCacheStore = _RedisFileCacheStore

logger = logging.getLogger(__name__)

ResourceMount: TypeAlias = (BaseResource | Mount
                            | tuple[BaseResource, MountMode]
                            | tuple[BaseResource, MountMode,
                                    dict[str, CommandSafeguard]])


class Workspace:
    """Unified virtual filesystem over heterogeneous resources.

    Manages mounts, caching, and command execution.
    All ops are forwarded directly to the resolved resource.
    """

    def __init__(
        self,
        resources: dict[str, ResourceMount],
        cache_limit: str | int = "512MB",
        cache: CacheConfig | None = None,
        index: IndexConfig | None = None,
        mode: MountMode = MountMode.READ,
        consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY,
        session_id: str | None = None,
        agent_id: str | None = None,
        workspace_id: str | None = None,
        store: WorkspaceStateStore | None = None,
        owns_store: bool = False,
        observe: ObserverStore | None = None,
        namespace_store: NamespaceStore | None = None,
        session_store: SessionStore | None = None,
        runtimes: list[Runtime | str] | None = None,
    ) -> None:
        self._registry = MountRegistry()
        # One provider scopes every control-plane store by workspace id;
        # the per-plane params (observe / namespace_store / session_store)
        # remain as direct overrides that win over the provider.
        self._workspace_id = workspace_id if workspace_id is not None \
            else new_workspace_id()
        # A minted default session id is provisional: attaching to a
        # workspace whose discovery record already names one adopts the
        # stored pointer instead (see _ensure_meta).
        self._session_id_explicit = session_id is not None
        if session_id is None:
            session_id = new_session_id()
        # A caller-passed provider may be shared with sibling workspaces,
        # so only a workspace that built its own provider closes it.
        self._owns_state_store = store is None or owns_store
        self._meta_written = False
        self._state_store = store if store is not None \
            else RAMWorkspaceStateStore()
        if observe is None:
            observe = self._state_store.observer(self._workspace_id)
        if namespace_store is None:
            namespace_store = self._state_store.namespace(self._workspace_id)
        if session_store is None:
            session_store = self._state_store.sessions(self._workspace_id)
        if isinstance(cache, RedisCacheConfig):
            if RedisFileCacheStore is None:
                raise ImportError(
                    "RedisCacheConfig requires the 'redis' extra. "
                    "Install with: pip install mirage-ai[redis]")
            self._cache = RedisFileCacheStore(
                cache_limit=cache.limit,
                url=cache.url,
                key_prefix=cache.key_prefix,
                max_drain_bytes=cache.max_drain_bytes,
            )
        else:
            limit = cache.limit if cache is not None else cache_limit
            max_drain = cache.max_drain_bytes if cache is not None else None
            self._cache = RAMFileCacheStore(cache_limit=limit,
                                            max_drain_bytes=max_drain)
        self._locked_paths: set[str] = set()
        self._closed = False
        self._async_closed = False
        self._close_lock = asyncio.Lock()
        # Resources reused from another live workspace (copy() / load
        # resource overrides) stay open here; their origin closes them.
        self._shared_resources: set[int] = set()
        self._drift_policy: DriftPolicy = DriftPolicy.OFF
        self._drift_check_pending: bool = False
        # Queued at Workspace.load: (mount, path, expected_fingerprint).
        # First dispatch/execute drains via asyncio.gather, then clears.
        self._pending_drift: list[tuple[MountEntry, str, str]] = []
        self.job_table = JobTable()
        self._current_agent_id: str | None = agent_id
        self._default_session_id = session_id
        self._default_agent_id = agent_id
        self._session_mgr = SessionManager(session_id, store=session_store)
        self._consistency = consistency
        self._registry.set_consistency(consistency)
        self._registry.attach_file_cache(self._cache)
        # Only an explicit agent_id claims the workspace user; a bare
        # launch adopts whatever identity the namespace store holds.
        self._namespace = Namespace(self._registry,
                                    store=namespace_store,
                                    user=agent_id)
        self._dispatcher = Dispatcher(self._namespace, self._cache,
                                      consistency)
        self._registry.set_reconciler(self._dispatcher.reconciler)

        fuse_targets: list[tuple[str, bool | str]] = []
        for prefix, value in resources.items():
            mount_safeguards: dict[str, CommandSafeguard] = {}
            mount_fuse: bool | str = False
            if isinstance(value, Mount):
                prov = value.resource
                mount_mode = value.mode if value.mode is not None else mode
                if value.command_safeguards:
                    mount_safeguards = dict(value.command_safeguards)
                mount_fuse = value.fuse
            elif isinstance(value, tuple):
                if len(value) not in (2, 3):
                    raise TypeError(
                        "resource tuples must be (resource, mode) or "
                        "(resource, mode, command_safeguards)")
                prov = value[0]
                mount_mode = value[1]
                if len(value) == 3 and value[2]:
                    mount_safeguards = dict(value[2])
            else:
                prov = value
                mount_mode = mode
            prov.set_index(index)
            mount_obj = self._registry.mount(prefix, prov, mount_mode)
            if mount_safeguards:
                mount_obj.command_safeguards.update(mount_safeguards)
            if mount_fuse:
                fuse_targets.append((prefix, mount_fuse))

        self._implicit_root = self._registry.root_mount is None
        if self._implicit_root:
            self._registry.mount("/", RAMResource(), mode)

        self._fuse_mountpoints: dict[str, str] = {}
        self._fuse_managers: dict[str, FuseManager] = {}

        self.observer = Observer(store=observe)
        self._registry.mount(HISTORY_PREFIX,
                             HistoryViewResource(self.observer),
                             MountMode.READ)

        self._ops = Ops(self._registry.ops_mounts(),
                        on_write=self._invalidate_after_write_by_path,
                        observer=self.observer,
                        agent_id=agent_id or "",
                        session_id=session_id,
                        links=self._namespace,
                        stat_overlay=self._merge_overlay)

        # The workspace's ordered runtime world: instances and the vfs
        # marker, first capturer binds each command. An explicit list
        # fails loud per entry; the default world builds gracefully (a
        # missing extra leaves the command reporting its install hint
        # per invocation, never a silent escalation to another runtime).
        self._runtime_entries = self._resolve_runtime_entries(runtimes)
        self._registry.runtime_bindings = bind_commands(self._runtime_entries)

        for prefix, fuse_target in fuse_targets:
            mountpoint = fuse_target if isinstance(fuse_target, str) else None
            self.add_fuse_mount(prefix, mountpoint)

    async def history(self) -> list[dict[str, Any]]:
        """Command events recorded by the hidden recorder.

        Returns:
            list[dict]: All sessions' command events, timestamp order.
        """
        return await self.observer.command_events()

    @property
    def ops(self) -> Ops:
        return self._ops

    @property
    def namespace(self) -> Namespace:
        return self._namespace

    @property
    def cache(self):
        return self._cache

    @property
    def max_drain_bytes(self) -> int | None:
        return self._cache.max_drain_bytes

    @max_drain_bytes.setter
    def max_drain_bytes(self, value: int | None) -> None:
        self._cache.max_drain_bytes = value

    def mounts(self) -> list[Any]:
        return self._registry.mounts()

    @property
    def revisions(self) -> dict[str, str]:
        """Flat view of every mount's installed revision pins.

        Derived (read-only) — the source of truth lives per-mount on
        ``mount.revisions``. Useful for tests, audit ("which paths got
        pinned at load?"), and debugging. Empty until a snapshot is
        loaded with revisions in its manifest.
        """
        out: dict[str, str] = {}
        for m in self._registry.mounts():
            if m.revisions:
                out.update(m.revisions)
        return out

    def mount(self, prefix: str):
        return self._registry.mount_for(prefix)

    async def unmount(self, prefix: str) -> None:
        if self._closed:
            raise RuntimeError("Workspace is closed")
        stripped = prefix.strip("/")
        norm = ("/" + stripped + "/" if stripped else "/")
        if norm == "/":
            raise ValueError(f"cannot unmount the virtual root: {prefix!r}")
        if norm == "/dev/":
            raise ValueError("cannot unmount reserved prefix: '/dev/'")
        if norm == HISTORY_PREFIX + "/":
            raise ValueError(f"cannot unmount history view: "
                             f"{HISTORY_PREFIX!r}")
        removed = self._registry.unmount(prefix)
        self._ops.unmount(prefix)
        remaining = self._registry.mounts()
        still_instance = any(m.resource is removed.resource for m in remaining)
        still_kind = any(m.resource.name == removed.resource.name
                         for m in remaining)
        if not still_kind:
            self._ops._registry.unregister_resource(removed.resource.name)
        if not still_instance:
            close = getattr(removed.resource, "close", None)
            if callable(close):
                result = close()
                if hasattr(result, "__await__"):
                    await result

    def _register_fuse(self, prefix: str, mountpoint: str) -> None:
        for other_prefix, other_mp in self._fuse_mountpoints.items():
            if other_mp == mountpoint and other_prefix != prefix:
                raise ValueError(
                    f"FUSE mountpoint {mountpoint!r} already used by "
                    f"prefix {other_prefix!r}; mounts need distinct paths")
        self._fuse_mountpoints[prefix] = mountpoint

    def _deregister_fuse(self, prefix: str) -> None:
        self._fuse_mountpoints.pop(prefix, None)

    def add_fuse_mount(self,
                       prefix: str,
                       mountpoint: str | None = None,
                       session_id: str | None = None) -> str:
        # Register a pinned path BEFORE mounting so a collision is rejected
        # without leaving a partial mount. Each mount gets its own manager,
        # so a workspace can expose any number of FUSE subtrees at once.
        # A session-bound mount runs every op under that session's mount
        # grants (the kernel-tier primitive: bind-mount the tree into a
        # container and the narrowing travels with it); it is keyed
        # separately so the same prefix can also be exposed unbound.
        session = (self._session_mgr.get(session_id)
                   if session_id is not None else None)
        key = prefix if session_id is None else f"{prefix}@{session_id}"
        if mountpoint is not None:
            self._register_fuse(key, mountpoint)
        fm = FuseManager()
        self._fuse_managers[key] = fm
        try:
            mp = fm.setup(self._ops, prefix, mountpoint, session=session)
        except Exception:
            # The mount never came up; drop the manager and any registered
            # path so fuse_mountpoints does not misreport it as live.
            self._fuse_managers.pop(key, None)
            self._deregister_fuse(key)
            raise
        if mountpoint is None:
            self._register_fuse(key, mp)
        return mp

    def remove_fuse_mount(self,
                          prefix: str,
                          session_id: str | None = None) -> None:
        key = prefix if session_id is None else f"{prefix}@{session_id}"
        fm = self._fuse_managers.pop(key, None)
        if fm is not None:
            fm.unmount()
        self._deregister_fuse(key)

    @property
    def fuse_mountpoint(self) -> str | None:
        if not self._fuse_mountpoints:
            return None
        if len(self._fuse_mountpoints) > 1:
            raise RuntimeError(
                "multiple FUSE mounts active; use fuse_mountpoints to "
                "select one by prefix")
        return next(iter(self._fuse_mountpoints.values()))

    @property
    def fuse_mountpoints(self) -> dict[str, str]:
        return dict(self._fuse_mountpoints)

    def _runtime_mount_prefixes(self) -> list[str]:
        # Pull-model provider for the wasm runtimes: read per run, so
        # mounts added or removed after construction are picked up.
        return self._ops.mount_prefixes()

    def _resolve_runtime_entries(
            self, runtimes: list[Runtime | str] | None) -> list[Runtime | str]:
        """Build and wire the workspace's ordered runtime world.

        Name strings become no-option instances; the vfs marker passes
        through; every instance gets the workspace dispatch attached.
        An explicit list fails loud per entry. The default world
        (monty, quickjs, vfs) builds gracefully: a missing extra skips
        the entry so its commands report the install hint per
        invocation, never a silent escalation to another runtime.

        Args:
            runtimes (list[Runtime | str] | None): user entries, or
                None for the default world.
        """
        entries: list[Runtime | str] = []
        if runtimes is None:
            for name in DEFAULT_ENTRIES:
                if name == VFS_ENTRY:
                    entries.append(VFS_ENTRY)
                    continue
                try:
                    entries.append(build_runtime(name))
                except (ImportError, FileNotFoundError):
                    continue
        else:
            for entry in runtimes:
                if isinstance(entry, str) and entry != VFS_ENTRY:
                    entries.append(build_runtime(entry))
                else:
                    entries.append(entry)
        for entry in entries:
            if isinstance(entry, Runtime):
                entry.attach(self.dispatch, self._runtime_mount_prefixes)
        return entries

    @property
    def _cwd(self) -> str:
        return self._session_mgr.cwd

    @_cwd.setter
    def _cwd(self, value: str) -> None:
        self._session_mgr.cwd = value

    @property
    def env(self) -> dict[str, str]:
        return self._session_mgr.env

    @env.setter
    def env(self, value: dict[str, str]) -> None:
        self._session_mgr.env = value

    @property
    def file_prompt(self) -> str:
        return build_file_prompt(self._registry.mounts())

    # ── lifecycle ───────────────────────────────────────────────────────────

    def __enter__(self) -> "Workspace":
        self._original_open = builtins.open
        self._original_os = sys.modules["os"]
        builtins.open = cast(Any, make_open(self._ops))
        sys.modules["os"] = make_os_module(self._ops)
        return self

    def __exit__(self, exc_type: type[BaseException] | None,
                 exc_value: BaseException | None,
                 traceback: TracebackType | None) -> None:
        builtins.open = self._original_open
        sys.modules["os"] = self._original_os
        run_async_from_sync(self.close())

    def _close_parts(self) -> None:
        if self._closed:
            return
        self._closed = True
        for fm in list(self._fuse_managers.values()):
            fm.unmount()
        self._fuse_managers.clear()
        self._fuse_mountpoints.clear()
        for job in self.job_table.running_jobs():
            self.job_table.kill(job.id)
        for task in self._cache._drain_tasks.values():
            task.cancel()
        self._cache._drain_tasks.clear()

    async def close(self) -> None:
        async with self._close_lock:
            if self._async_closed:
                return
            drain_tasks = list(self._cache._drain_tasks.values())
            for line_runtime in self._runtime_entries:
                if isinstance(line_runtime, Runtime):
                    await line_runtime.close()
            resources = {
                id(mount.resource): mount.resource
                for mount in self._registry.mounts()
                if id(mount.resource) not in self._shared_resources
            }
            await asyncio.gather(*(resource.close()
                                   for resource in resources.values()))
            if self._owns_state_store:
                await self._state_store.close()
            self._close_parts()
            for task in drain_tasks:
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            try:
                await self._cache.clear()
            finally:
                await self._cache.close()
            self._async_closed = True

    # ── snapshot / load / copy ─────────────────────────────────────────────

    async def snapshot(self, target, *, compress: str | None = None) -> None:
        """Serialize this workspace to a tar.

        Captured:
            * Mount configs, sessions, history, finished jobs.
            * Cache bytes for fast replay.
            * One fingerprint entry per remote read (ETag-equivalent,
              plus a backend-specific ``revision`` when the resource
              exposes one — e.g. S3 ``VersionId``).

        NOT captured:
            * Live state of mounts with ``SUPPORTS_SNAPSHOT=False``
              (Gmail, Slack, Linear, etc.). Load logs a warning naming
              them.
            * Files the agent never touched.
            * Bytes of remote objects. Recovery of original bytes works
              only when the resource accepts a revision pin (S3 family
              today) and the recorded revision still exists on the
              source.

        Async because fingerprint capture stats each touched path on a
        ``SUPPORTS_SNAPSHOT`` mount.

        Args:
            target: filesystem path OR a writable file-like object.
            compress: None | "gz" | "bz2" | "xz".
        """
        await _write_snapshot(self, target, compress=compress)

    @classmethod
    async def load(
            cls,
            source,
            *,
            resources: dict[str, Any] | None = None,
            drift_policy: DriftPolicy = DriftPolicy.STRICT) -> "Workspace":
        """Reconstruct a Workspace from a tar.

        For every recorded read:

        1. If the manifest entry carries a ``revision`` (e.g. S3
           ``VersionId``), the load installs it into the owning
           ``mount.revisions``. Replay reads pin to that revision via
           the ``revision_for`` contextvar lookup, so the original
           bytes are served. Drift check is skipped for these paths —
           the pin guarantees bytes match by construction.
        2. If the entry carries only a ``fingerprint`` (no stable
           revision), the load queues a drift check. STRICT raises
           ``ContentDriftError`` on the first mismatch; OFF skips the
           check entirely and evicts the snapshot cache so reads serve
           current state.

        Drift check is eager (fires once on the first dispatch or
        execute), so downstream code can rely on consistent state.

        Args:
            source: filesystem path OR a readable file-like object.
            resources: {prefix: Resource} overrides for mounts saved
                with redacted creds.
            drift_policy: STRICT (default) raises on mismatch. OFF
                disables drift checking and evicts snapshot cache for
                fingerprinted paths.
        """
        return await cls.from_state(read_tar(source),
                                    resources=resources,
                                    drift_policy=drift_policy)

    @classmethod
    async def from_state(
            cls,
            state: dict[str, Any],
            *,
            resources: dict[str, Any] | None = None,
            drift_policy: DriftPolicy = DriftPolicy.STRICT) -> "Workspace":
        """Reconstruct a Workspace directly from a state dict (no tar).

        The in-process inverse of ``to_state_dict``: build the mounts,
        restore content/cache/history, then install drift fingerprints.
        ``load`` is this plus a tar read; callers that already hold a
        state dict (e.g. a version checkout) should use this and skip the
        tar round-trip.

        Args:
            state: a state dict from ``to_state_dict`` or a version.
            resources: {prefix: Resource} overrides for mounts saved
                with redacted creds.
            drift_policy: STRICT (default) raises on mismatch. OFF
                disables drift checking and evicts snapshot cache for
                fingerprinted paths.
        """
        ws = await cls._from_state(state, resources=resources)
        install_fingerprints(ws,
                             state.get(StateKey.FINGERPRINTS) or [],
                             drift_policy)
        live_only = state.get(StateKey.LIVE_ONLY_MOUNTS) or []
        if live_only:
            logger.warning(
                "Workspace.from_state: %s mount(s) opt out of snapshot "
                "replay; reads against them will serve current state with "
                "no drift detection: %s", len(live_only), live_only)
        return ws

    async def copy(self) -> "Workspace":
        # Reuse this process's resources so remote backends (S3, Redis,
        # GDrive) stay shared between original and copy. Local backends
        # (RAM, Disk) restore their content fresh into the new resources
        # — see snapshot.api.snapshot docstring for the rationale.
        # Only reuse resources whose state has redacted secrets or connection
        # material. Local content resources (RAM, Disk) are reconstructed
        # fresh so the copy's writes don't clobber the original's data.
        state = await to_state_dict(self)
        auto_prefixes = {"/dev/", norm_mount_prefix(HISTORY_PREFIX)}
        prefix_to_resource = {
            m.prefix: m.resource
            for m in self._registry.mounts() if m.prefix not in auto_prefixes
        }
        resources = {
            m["prefix"]: prefix_to_resource[m["prefix"]]
            for m in state["mounts"] if requires_resource_override(m)
            and m["prefix"] in prefix_to_resource
        }
        return await type(self)._from_state(state, resources=resources)

    @classmethod
    async def _from_state(
            cls,
            state: dict[str, Any],
            *,
            resources: dict[str, Any] | None = None) -> "Workspace":
        args = build_mount_args(state, resources)
        ws = cls(args.mount_args,
                 consistency=args.consistency,
                 session_id=args.default_session_id,
                 agent_id=args.default_agent_id)
        if resources:
            ws._shared_resources = {id(r) for r in resources.values()}
        await apply_state_dict(ws, state)
        return ws

    def __deepcopy__(self, memo) -> "Workspace":
        raise NotImplementedError(
            "Workspace.copy is async (it captures fingerprints for replay). "
            "Call `await ws.copy()` directly instead of `copy.deepcopy(ws)`.")

    def __copy__(self) -> "Workspace":
        raise NotImplementedError("Workspace has no useful shallow copy — "
                                  "use `await ws.copy()`.")

    # ── session lifecycle ──────────────────────────────────────────────────

    def create_session(
        self,
        session_id: str,
        mounts: Mapping[str, MountMode | str] | Iterable[str] | None = None,
    ) -> Session:
        """Create a session, optionally restricted to per-mount modes.

        Args:
            session_id (str): unique id for the session.
            mounts (Mapping[str, MountMode | str] | Iterable[str] | None):
                per-mount modes. A mapping assigns each prefix a mode
                ceiling ("read", "write", "exec", or the filesystem
                aliases "r", "rw", "rwx"); a plain iterable of
                prefixes keeps each mount at its own configured mode (the
                previous allowlist behavior). ``None`` leaves the
                session unrestricted.
        """
        modes: dict[str, MountMode] | None = None
        if mounts is not None:
            if isinstance(mounts, str):
                mounts = [mounts]
            if isinstance(mounts, Mapping):
                modes = {
                    ("/" + p.strip("/")): parse_mount_mode(m)
                    for p, m in mounts.items()
                }
            else:
                modes = {("/" + p.strip("/")): MountMode.EXEC for p in mounts}
            for prefix in self._infrastructure_mount_prefixes():
                modes.setdefault(prefix, MountMode.EXEC)
        return self._session_mgr.create(session_id, mount_modes=modes)

    def _infrastructure_mount_prefixes(self) -> set[str]:
        """Mount prefixes a session is always allowed to touch.

        The implicit scratch root (where text-processing commands like
        ``wc`` without a path argument resolve), the device mount, and
        the history view are infrastructure: they hold no user
        credentials, and rejecting them would break common shell
        idioms or the history builtin. A user-defined root mount is
        NOT infrastructure; sessions must be granted ``/`` explicitly
        to touch it.
        """
        prefixes = {"/dev", HISTORY_PREFIX}
        if self._implicit_root:
            prefixes.add("/")
        return prefixes

    def get_session(self, session_id: str) -> Session:
        return self._session_mgr.get(session_id)

    def list_sessions(self) -> list[Session]:
        return self._session_mgr.list()

    async def ensure_sessions_loaded(self) -> None:
        """Hydrate sessions from the session store (idempotent).

        The discovery record resolves first so a minted default session
        id can adopt the stored pointer before hydration keys off it.
        """
        await self._ensure_meta()
        await self._session_mgr.ensure_loaded()

    @property
    def workspace_id(self) -> str:
        return self._workspace_id

    @property
    def default_session_id(self) -> str:
        return self._session_mgr.default_id

    @property
    def state_store(self) -> WorkspaceStateStore:
        return self._state_store

    async def workspace_meta(self) -> dict[str, Any]:
        """This workspace's metadata record (discovery surface)."""
        await self._ensure_meta()
        meta = await self._state_store.load_meta(self._workspace_id)
        return meta if meta is not None else {}

    async def _ensure_meta(self) -> None:
        """Write the discovery record once per process.

        An existing record wins (another process or an earlier run of
        this workspace already registered it); a fresh workspace
        registers itself so siblings pointed at the same store can find
        its sessions and default session.
        """
        if self._meta_written:
            return
        existing = await self._state_store.load_meta(self._workspace_id)
        if existing is None:
            created = await self._state_store.cas_set_meta(
                self._workspace_id, {
                    "workspace_id": self._workspace_id,
                    "default_session_id": self._default_session_id,
                    "created_at": time.time(),
                    "generation": 1,
                }, 0)
            if not created:
                # Lost the create race: a sibling registered first and
                # its record wins, like any other existing record.
                existing = await self._state_store.load_meta(self._workspace_id
                                                             )
        if existing is not None:
            stored = existing.get("default_session_id")
            if not self._session_id_explicit and isinstance(stored, str):
                self._session_mgr.adopt_default(stored)
                self._default_session_id = stored
        self._meta_written = True

    async def flush_sessions(self) -> None:
        """Persist every session's durable fields to the session store."""
        await self._session_mgr.flush()

    async def close_session(self, session_id: str) -> None:
        await self._session_mgr.close(session_id)

    async def close_all_sessions(self) -> None:
        await self._session_mgr.close_all()

    # ── mount management ────────────────────────────────────────────────────

    def _merge_overlay(self, path: str, stat: FileStat) -> FileStat:
        """Overlay namespace attrs onto an ops-facade stat.

        Injected into Ops so FUSE and the os patch report chmod/chown/touch
        results identically to dispatch("stat").

        Args:
            path (str): virtual path (already link-resolved).
            stat (FileStat): the backend-reported stat.
        """
        return merge_overlay_stat(self._namespace.meta_for(path), stat)

    async def dispatch(self, op: str, path: PathSpec,
                       **kwargs: Any) -> tuple[Any, IOResult]:
        await self._namespace.ensure_loaded()
        if self._drift_check_pending:
            await self._run_pending_drift_check()
        return await self._dispatcher.dispatch(op, path, **kwargs)

    async def _run_pending_drift_check(self) -> None:
        """Drain the post-load drift check.

        Called once on the first async entry point (``dispatch`` or
        ``execute``) after ``Workspace.load`` with a non-OFF drift
        policy. Stats every queued ``(mount, path, expected_fingerprint)``
        triple against the live source in parallel and raises
        :class:`ContentDriftError` on the first mismatch. Subsequent
        calls are no-ops.

        Pinned paths (those whose manifest entry carried a stable
        revision) are never enqueued, because the pin guarantees bytes
        match by construction.

        Stats are issued with ``asyncio.gather`` so first-op latency
        does not scale linearly with the number of recorded reads.
        """
        self._drift_check_pending = False
        if not self._pending_drift:
            return
        checks = [
            check_drift(self, path, fingerprint)
            for _, path, fingerprint in self._pending_drift
        ]
        self._pending_drift.clear()
        results = await asyncio.gather(*checks, return_exceptions=True)
        for r in results:
            if isinstance(r, BaseException):
                raise r

    async def stat(self, path: str) -> FileStat:
        scope = PathSpec(virtual=path,
                         directory=path,
                         resource_path="",
                         resolved=True)
        result, _ = await self.dispatch("stat", scope)
        return result

    async def readdir(self, path: str) -> list[str]:
        scope = PathSpec(virtual=path,
                         directory=path,
                         resource_path="",
                         resolved=False)
        raw, _ = await self.dispatch("readdir", scope)
        return raw

    # ── execution ────────────────────────────────────────────────────────────

    async def apply_io(self,
                       io: IOResult,
                       records: list[OpRecord] | None = None) -> None:
        await self._dispatcher.apply_io(io, records=records)

    async def _invalidate_after_write_by_path(self, path: str) -> None:
        await self._dispatcher.invalidate_after_write_by_path(path)

    def _session_cwd(self, session_id: str) -> str | None:
        try:
            return self._session_mgr.get(session_id).cwd
        except KeyError:
            return None

    async def _plan_eval_stub(self, cmd: str, **opts: Any) -> IOResult:
        """Inert evaluator for provision walks.

        A dry run must never execute: a command substitution with side
        effects ($(tee ...)) would otherwise run while "estimating".
        Substitutions expand to empty, so affected words degrade the
        plan to honest UNKNOWN instead of resolving via execution.
        """
        return IOResult()

    async def _exec_recursion(self, cancel: asyncio.Event | None, cmd: str,
                              **opts: Any) -> Any:
        # The executor's internal eval ($(), source, eval, xargs, ...):
        # never a typed line, so it must not record a history entry or
        # open its own recording context (GNU: history is appended by
        # the line reader, the evaluator can't touch it).
        return await self.execute(cmd, cancel=cancel, record=False, **opts)

    @overload
    async def execute(self,
                      command: str,
                      session_id: str | None = ...,
                      stdin: ByteSource | None = ...,
                      provision: Literal[False] = ...,
                      agent_id: str | None = ...,
                      cwd: str | None = ...,
                      env: dict[str, str] | None = ...,
                      cancel: asyncio.Event | None = ...,
                      record: bool = ...) -> IOResult:
        ...

    @overload
    async def execute(self,
                      command: str,
                      session_id: str | None = ...,
                      stdin: ByteSource | None = ...,
                      *,
                      provision: Literal[True],
                      agent_id: str | None = ...,
                      cwd: str | None = ...,
                      env: dict[str, str] | None = ...,
                      cancel: asyncio.Event | None = ...,
                      record: bool = ...) -> ProvisionResult:
        ...

    async def execute(
        self,
        command: str,
        session_id: str | None = None,
        stdin: ByteSource | None = None,
        provision: bool = False,
        agent_id: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cancel: asyncio.Event | None = None,
        record: bool = True,
    ) -> IOResult | ProvisionResult:
        """Execute a shell command in the workspace.

        Args:
            command: The shell command string to execute.
            session_id: Session whose persistent state hosts the command.
            stdin: Optional stdin payload (bytes or async byte iterator).
            provision: If True, return a ProvisionResult instead of running.
            agent_id: Agent identifier for observability and history.
            cwd: Per-call working directory override. When provided, the
                command runs in an ephemeral session clone (bash subshell
                semantics): the persistent session's cwd is unchanged and
                any `cd` inside the command does not leak.
            env: Per-call environment overrides layered on top of the
                session's env. Like cwd, these apply only to an ephemeral
                clone, so `export` inside the command does not leak back
                to the persistent session.
            cancel: Optional asyncio.Event used to abort execution
                mid-flight. When set, the executor raises MirageAbortError
                at the next gate (entry to each node) and races inside
                blocking sleeps so cancellation is observed promptly.
            record: When False, run without logging a history entry or
                opening a recording context; ops emitted by the command
                flow into the caller's recorder. Used by the executor's
                internal evaluations and available to SDK callers that
                need an unrecorded run.
        """
        if cancel is not None and cancel.is_set():
            raise MirageAbortError()
        await self._namespace.ensure_loaded()
        await self._ensure_meta()
        await self._session_mgr.ensure_loaded()
        if self._drift_check_pending:
            await self._run_pending_drift_check()

        if session_id is None:
            session_id = self._session_mgr.default_id
        session = self._session_mgr.get(session_id)
        use_override = cwd is not None or env is not None
        if use_override:
            overrides: dict[str, Any] = {}
            if cwd is not None:
                overrides["cwd"] = cwd
            if env is not None:
                overrides["env"] = {**session.env, **env}
            effective_session = session.fork(**overrides)
        else:
            effective_session = session
        self._current_agent_id = (agent_id if agent_id is not None else
                                  self._default_agent_id)
        io = IOResult()
        # The line-reader decision (GNU: history is appended where the
        # typed line is read, never inside the evaluator). Internal
        # evaluations and provision runs get an inert scope.
        is_line = record and not provision
        scope = RecordingScope(active=is_line)

        exec_recursion = partial(self._exec_recursion, cancel)

        session_token = set_current_session(effective_session)
        try:
            ast = parse(command)
            offending = find_syntax_error(ast)
            if offending is not None:
                snippet = offending.strip()[:40]
                err = (f"mirage: syntax error near {snippet!r}\n".encode()
                       if snippet else b"mirage: syntax error in command\n")
                io = IOResult(exit_code=2, stderr=err)
                return io
            if provision:
                prov_name = command.strip().split()[0] if command.strip(
                ) else None
                prov_resolved = (resolve_safeguard(prov_name)
                                 if prov_name else None)
                prov_timeout = (prov_resolved.timeout_seconds
                                if prov_resolved is not None else None)
                return await run_with_timeout(
                    provision_node(self._registry, self.dispatch,
                                   self._plan_eval_stub, self._namespace, ast,
                                   effective_session), prov_timeout, prov_name
                    or "")
            io, _ = await run_command_tree(
                self.dispatch,
                self._registry,
                self._namespace,
                self.job_table,
                exec_recursion,
                self._current_agent_id or "",
                ast,
                effective_session,
                stdin,
                cancel,
            )
            session.last_exit_code = io.exit_code
            await self.apply_io(io, records=scope.records)
            return io
        except CommandTimeoutError as exc:
            logger.debug("command %r timed out after %ss", exc.command,
                         exc.seconds)
            if cancel is not None:
                cancel.set()
            msg = (str(exc) + "\n").encode()
            io = IOResult(exit_code=124, stderr=msg)
            session.last_exit_code = 124
            return io
        except (MirageAbortError, ContentDriftError):
            raise
        except FindParseError as exc:
            msg = f"{exc}\n".encode()
            io = IOResult(exit_code=1, stderr=msg)
            return io
        except UsageError as exc:
            msg = f"{exc}\n".encode()
            io = IOResult(exit_code=exc.exit_code, stderr=msg)
            return io
        except OSError as exc:
            cmd_name = command.split()[0] if command.split() else command
            msg = format_fs_error(cmd_name, exc)
            io = IOResult(exit_code=1, stderr=msg)
            return io
        except Exception as exc:
            io = IOResult(exit_code=1, stderr=str(exc).encode())
            return io
        finally:
            # One rule on every path: an op that happened is always
            # accounted, in byte accounting (which feeds snapshot
            # fingerprints/drift) and as observer op events. The
            # command event's exit_code says whether the line that
            # emitted them succeeded.
            scope.close()
            reset_current_session(session_token)
            await self._session_mgr.flush()
            self._ops.records.extend(scope.records)
            if is_line:
                await self.observer.log_execution(
                    command, io, scope.records, self._current_agent_id or "",
                    session_id, self._session_cwd(session_id))
