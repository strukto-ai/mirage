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
import logging
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from types import TracebackType
from typing import Any, Literal, overload

from mirage.bridge.sync import run_async_from_sync
from mirage.cache.file.config import CacheConfig
from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.index import IndexConfig
from mirage.commands.cli import CLISpec
from mirage.commands.cli.specs import cli_spec_for
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.observe.observer import Observer
from mirage.observe.record import OpRecord
from mirage.observe.store import ObserverStore
from mirage.ops import Ops
from mirage.policy import (AskHandler, Decisions, Explanation,
                           PermissionsPolicy, Policies, Policy, PolicyError,
                           ScriptPolicy, SessionProfile)
from mirage.provision import ProvisionResult
from mirage.resource.history import HISTORY_PREFIX, HistoryViewResource
from mirage.runtime.base import Runtime
from mirage.runtime.resolver import PrefixResolver
from mirage.runtime.routing import RouteDecision, RoutePolicy
from mirage.secrets.config import EnvVar, SecretSource
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import source_for
from mirage.secrets.sources import resolve_sources
from mirage.secrets.types import ResolvedSource
from mirage.shell import parse
from mirage.shell.job_table import ConsoleFactory, JobTable
from mirage.types import (ConsistencyPolicy, DriftPolicy, FileEvent, FileStat,
                          JsonValue, MountBackend, MountMode, PathSpec)
from mirage.utils.ids import new_session_id, new_workspace_id
from mirage.workspace.cli import CLIInstall
from mirage.workspace.dispatcher import Dispatcher
from mirage.workspace.file_prompt import build_file_prompt
from mirage.workspace.mount import MountEntry, MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.namespace.store import NamespaceStore
from mirage.workspace.node.explain import explain_line
from mirage.workspace.session import Session, SessionManager, SessionStore
from mirage.workspace.session.constants import DEFAULT_PROFILE
from mirage.workspace.session.resolve import (apply_profile, compile_profile,
                                              resolve_profile, with_inline)
from mirage.workspace.session.session import vars_from_entries
from mirage.workspace.session.validate import check_cli_verbs
from mirage.workspace.snapshot import (DriftQueue, apply_state_dict,
                                       build_mount_args, install_fingerprints,
                                       read_tar)
from mirage.workspace.snapshot import snapshot as _write_snapshot
from mirage.workspace.snapshot import to_state_dict
from mirage.workspace.snapshot.keys import StateKey
from mirage.workspace.snapshot.state import (CLIOverrides, reusable_clis,
                                             reusable_resources)
from mirage.workspace.store import WorkspaceStateStore
from mirage.workspace.workspace.build import (resolve_control_stores,
                                              wire_runtime_world)
from mirage.workspace.workspace.cache import build_file_cache
from mirage.workspace.workspace.execute import execute_line
from mirage.workspace.workspace.guard import reject_config_script
from mirage.workspace.workspace.kernel_mounts import KernelMounts
from mirage.workspace.workspace.lifecycle import (close_async, patch_process,
                                                  stop_vfs_loop,
                                                  unpatch_process)
from mirage.workspace.workspace.meta import WorkspaceMeta
from mirage.workspace.workspace.mounts import (install_mounts, kernel_targets,
                                               normalize_resources)
from mirage.workspace.workspace.mounts import unmount as unmount_prefix
from mirage.workspace.workspace.types import ResourceMount
from mirage.workspace.workspace.watch import WatchDelegate, WatchManager

logger = logging.getLogger(__name__)


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
        console_factory: ConsoleFactory | None = None,
        runtimes: list[Runtime | str] | None = None,
        route_policy: RoutePolicy | None = None,
        profiles: Mapping[str, SessionProfile | Mapping[str, Any]]
        | None = None,
        profile: str | None = None,
        policies: list[Policy] | None = None,
        on_ask: AskHandler | None = None,
        clis: dict[str, tuple[str | CLISpec, dict[str, Any] | None]]
        | None = None,
        env: Mapping[str, str | EnvVar | Mapping[str, Any]] | None = None,
        secrets: Mapping[str, SecretSource | Mapping[str, Any]] | None = None,
    ) -> None:
        self._registry = MountRegistry()
        # The permission profiles: one per name, and the one a session
        # gets when it names none. A profile is the whole document a
        # session runs under, so there is no workspace-wide block
        # above it. Both accept the plain mapping a YAML file or the
        # TypeScript constructor would hold; model_validate is a no-op
        # on an already-built model.
        self._profiles: dict[str, SessionProfile] = {
            name: SessionProfile.model_validate(doc)
            for name, doc in (profiles or {}).items()
        }
        self._default_profile_name = profile
        if profile is not None and profile not in self._profiles:
            raise PolicyError(f"unknown profile {profile!r}")
        # One provider scopes every control-plane store by workspace id;
        # the per-plane params (observe / namespace_store / session_store)
        # remain as direct overrides that win over the provider.
        self._workspace_id = workspace_id if workspace_id is not None \
            else new_workspace_id()
        # A minted default session id is provisional: attaching to a
        # workspace whose discovery record already names one adopts the
        # stored pointer instead (see WorkspaceMeta).
        session_id_explicit = session_id is not None
        if session_id is None:
            session_id = new_session_id()
        stores = resolve_control_stores(self._workspace_id, store, owns_store,
                                        observe, namespace_store,
                                        session_store)
        self._owns_state_store = stores.owned
        self._state_store = stores.state_store
        self._cache: FileCacheMixin = build_file_cache(cache, cache_limit)
        self._closed = False
        self._async_closed = False
        self._close_lock = asyncio.Lock()
        # Resources reused from another live workspace (copy() / load
        # resource overrides) stay open here; their origin closes them.
        self._shared_resources: set[int] = set()
        self._drift = DriftQueue()
        self.job_table = JobTable(console_factory)
        self._default_agent_id = agent_id
        # The env block, translated once: a literal entry becomes an
        # exported var, a managed one becomes a pointer the fill step
        # resolves at command time. Each managed entry's source is
        # resolved now, so a typo'd name or a missing optional
        # dependency fails at construction, naming the known sources,
        # rather than at the first fetch.
        # The source table, kept as declarations: building one reads
        # its bootstrap pointers, which is I/O, and this constructor is
        # sync. `_secret_sources` builds them once, before the first
        # fetch.
        # Named for what it holds: the source *declarations*, never a
        # secret. Spelling it `secret_blocks` made every reader (and
        # CodeQL's name heuristic, which flagged the instance name in a
        # log line as a credential) believe otherwise.
        # Checked here, so every caller-supplied route is covered at
        # once: a list arrives from an untyped REST override, and
        # `Object.entries`/`.items()` on one yields nothing, so the
        # declarations would silently vanish and every restored pointer
        # would read as an unknown source.
        if secrets is not None and not isinstance(secrets, Mapping):
            raise SecretsError("config `secrets` must be a mapping, got "
                               f"{type(secrets).__name__}")
        self._declared_sources: dict[str, SecretSource] = {
            name: (block if isinstance(block, SecretSource) else
                   SecretSource.model_validate(block))
            for name, block in (secrets or {}).items()
        }
        self._secret_sources_built: dict[str, ResolvedSource] | None = None
        self._secret_sources_task: asyncio.Task[dict[
            str, ResolvedSource]] | None = None
        for block in self._declared_sources.values():
            source_for(block.source)
        seed_vars = vars_from_entries(env) if env else None
        for var in (seed_vars or {}).values():
            if (var.managed is not None
                    and var.managed.source not in self._declared_sources):
                source_for(var.managed.source)
        self._session_mgr = SessionManager(session_id,
                                           store=stores.sessions,
                                           seed_vars=seed_vars)
        # Admission policies, consulted in registration order after the
        # built-ins the registry seeds: the profile's admission rules
        # (PermissionsPolicy, reading each session's compiled rules
        # from the manager by the id the door puts in the context), the
        # profile's policy (ScriptPolicy, calling its hook per command
        # through the same manager), then Policy instances, then anything added
        # later through ws.policies.add(). The route policy
        # (route_policy=) is the line-level counterpart until it is
        # absorbed as a hook.
        self._registry.policies.add(PermissionsPolicy(self._session_mgr))
        # The doors the runtime world attaches (below), so a profile
        # script reads the mounts an agent's program would, and through
        # the same gate. The link source is a lambda because the
        # namespace is built after this and read only at run time.
        self._sandbox_resolver = PrefixResolver(
            self._sandbox_visible_mounts,
            lambda directory: self._namespace.link_names_under(directory))
        self._script_policy = ScriptPolicy(self._session_mgr,
                                           self._mount_prefixes,
                                           dispatch=self.dispatch,
                                           resolver=self._sandbox_resolver)
        self._registry.policies.add(self._script_policy)
        for entry in policies or []:
            self._registry.policies.add(entry)
        # The ledger an Ask is taken to (design 3.9): records live on
        # the sessions, the host answers through `on_ask` (or just
        # records the question when none is wired) and reads
        # `ws.decisions`.
        self._registry.decisions = Decisions(self._session_mgr, on_ask)
        self._meta = WorkspaceMeta(self._workspace_id, self._state_store,
                                   self._session_mgr, session_id,
                                   session_id_explicit)
        self._consistency = consistency
        self._registry.set_consistency(consistency)
        self._registry.attach_file_cache(self._cache)
        # Only an explicit agent_id claims the workspace user; a bare
        # launch adopts whatever identity the namespace store holds.
        self._namespace = Namespace(self._registry,
                                    store=stores.namespace,
                                    user=agent_id)
        self._dispatcher = Dispatcher(self._namespace,
                                      self._cache,
                                      consistency,
                                      drift=self._drift)
        self._registry.set_reconciler(self._dispatcher.reconciler)
        self._watch = WatchManager(self._registry)

        specs = normalize_resources(resources, mode)
        self._implicit_root = install_mounts(self._registry, specs, index,
                                             mode)
        # What the workspace and its mounts hide from every session,
        # stamped onto the default session now and onto every session
        # created or hydrated later.
        # The workspace's own session is a session created without a
        # name, so the default profile shapes it too: the primary agent
        # is not the one agent the document cannot reach.
        default_base = self._base_profile(None)
        self._session_mgr.default_profile = (compile_profile(
            default_base, self._profile_name(None)) if default_base is not None
                                             else None)

        self.observer = Observer(store=stores.observe)
        self._registry.mount(HISTORY_PREFIX,
                             HistoryViewResource(self.observer),
                             MountMode.READ)
        # The facade delegates every op to the dispatcher, so FUSE and
        # programmatic ws.fs walk the same pipeline as a shell command
        # and the policy gates fire exactly once, at that door.
        self._ops = Ops(self._registry.ops_mounts(),
                        observer=self.observer,
                        agent_id=agent_id or "",
                        session_id=session_id,
                        links=self._namespace,
                        dispatch=self._dispatcher.dispatch)
        self._kernel_mounts = KernelMounts(self._ops, self._session_mgr)
        # Held only while the workspace is a context manager; set by
        # lifecycle.patch_process. Declared here because the pair was
        # invented by assignment, so an unpatch without a patch raised
        # AttributeError instead of restoring nothing.
        self._original_open: Callable[..., Any] | None = None
        self._original_io_open: Callable[..., Any] | None = None
        self._original_os_names: dict[str, Callable[..., Any]] | None = None
        self._vfs_loop: asyncio.AbstractEventLoop | None = None

        self._runtimes, self._router = wire_runtime_world(
            self._registry, self.dispatch, self._sandbox_resolver, runtimes)
        reject_config_script("route_policy", route_policy)
        self._route_policy = route_policy

        # Installed CLIs, fully separate from mounts: the YAML `clis:`
        # section arrives as {head: (spec key or tree, config)}; a spec
        # key resolves against the named registry and every entry
        # installs through the same fail-loud path as register_cli.
        if clis:
            for cli_name, (spec_or_key, cli_config) in clis.items():
                cli_spec = (spec_or_key if isinstance(spec_or_key, CLISpec)
                            else cli_spec_for(spec_or_key))
                self._registry.clis.install(cli_name, cli_spec, cli_config)

        for prefix, target_backend, target_point in kernel_targets(specs):
            self.add_fuse_mount(prefix, target_point, backend=target_backend)

    async def history(self) -> list[dict[str, Any]]:
        """Command events recorded by the hidden recorder.

        Returns:
            list[dict]: All sessions' command events, timestamp order.
        """
        return await self.observer.command_events()

    async def explain(self,
                      line: str,
                      session_id: str = "") -> list[Explanation]:
        """What a line would do under a session's profile, without
        running any of it.

        The dry run of the gate every command passes through, so this
        and the refusal an agent would read come out of one place and
        cannot disagree. It runs no command, expands nothing, spends no
        grant and puts no question to a host, which is what makes it
        safe to call about a line nobody typed.

        Host-side only. The structure of a profile's rules is an
        operator's business, so there is no builtin an agent can type
        to read it.

        Args:
            line (str): the line to judge, as an agent would type it.
            session_id (str): whose profile to judge it under; the
                default session when empty.

        Returns:
            list[Explanation]: one per command the gate reads, in gate
            order, nested lines included.
        """
        await self.ensure_sessions_loaded()
        session = self.get_session(session_id or self.default_session_id)
        return await explain_line(parse(line), session, self._registry,
                                  self._namespace)

    @property
    def declared_sources(self) -> Mapping[str, SecretSource]:
        """The `secrets:` declarations this workspace was built with.

        Read by the paths that rebuild a workspace from state: a
        snapshot never carries the block, because it is the
        deployment's credentials, so a same-process rebuild has to
        carry it across or the restored pointers name instances the new
        workspace never heard of.
        """
        return self._declared_sources

    async def _secret_sources(self) -> Mapping[str, ResolvedSource]:
        """The declared source instances, built once.

        Deferred rather than done in the constructor because building
        one reads its bootstrap pointers, and a dotenv file is I/O. The
        first line that fills pays for it; every later line reads the
        table. Resolution touches only the process env and dotenv
        files, never a remote store, so a failure here is a bad
        declaration and rightly fails every line, while an unreachable
        store still fails only the names that want it.
        """
        if self._secret_sources_built is not None:
            return self._secret_sources_built
        # The in-flight resolution is cached, not just its result: two
        # sessions filling concurrently would both find the memo empty
        # across the await and read every bootstrap source twice, and a
        # rotation between the two reads would leave the loser's config
        # on one of the lines. Cleared either way, so a failed
        # resolution is retried by the next line rather than pinned
        # forever.
        task = self._secret_sources_task
        if task is None:
            task = asyncio.ensure_future(
                resolve_sources(self._declared_sources))
            self._secret_sources_task = task
        try:
            # Shielded: the task is shared, so a waiter whose own
            # execute() is cancelled (a wait_for timeout) must not take
            # the resolution down with it and cancel the other session
            # too.
            built = await asyncio.shield(task)
        finally:
            # Cleared only once the shared task itself is finished. A
            # cancelled waiter dropping the handle would leave the next
            # caller starting a second resolution beside the one still
            # running.
            if task.done():
                self._secret_sources_task = None
        self._secret_sources_built = built
        return built

    @property
    def _has_managed_env(self) -> bool:
        """True once any session may hold a managed variable.

        The manager owns the fact because sessions are where pointers
        live: the workspace's env block, a created session's own
        entries, a hydrated record and a snapshot all land there. The
        executor skips the fill pass entirely while this is False.
        """
        return self._session_mgr.has_managed_env

    @property
    def fs(self) -> Ops:
        """The op facade: read/write/stat/readdir/... against the mounts.

        Named as TypeScript names it (`ws.fs`), so one host API reads the
        same in both languages; the `Ops` class name stays, since it is
        the op vocabulary the dispatcher speaks, not a filesystem.
        """
        return self._ops

    @property
    def namespace(self) -> Namespace:
        return self._namespace

    @property
    def cache(self) -> FileCacheMixin:
        return self._cache

    @property
    def policies(self) -> Policies:
        """The workspace's admission policies; add() registers more.

        Ordered, built-ins first; on a pre hook the first Deny wins, so
        adding a policy can only restrict the workspace.
        """
        return self._registry.policies

    @property
    def decisions(self) -> Decisions:
        """The host's door on asked commands: ``list()`` every record,
        ``pending()`` the ones waiting, ``answer(id, outcome, scope)``
        one, and the agent's retry passes or is refused.
        """
        return self._registry.decisions

    @property
    def max_drain_bytes(self) -> int | None:
        return self._cache.max_drain_bytes

    @max_drain_bytes.setter
    def max_drain_bytes(self, value: int | None) -> None:
        self._cache.max_drain_bytes = value

    def mounts(self) -> list[MountEntry]:
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
        await unmount_prefix(self._registry, self._ops, prefix)

    def add_fuse_mount(self,
                       prefix: str,
                       mountpoint: str | None = None,
                       session_id: str | None = None,
                       backend: str | MountBackend = MountBackend.FUSE) -> str:
        """Expose ``prefix`` at a real mountpoint and return its path.

        Args:
            prefix (str): the virtual prefix to expose.
            mountpoint (str | None): where to mount; None picks a path.
            session_id (str | None): session whose mount grants scope
                every op served through this mountpoint.
            backend (str | MountBackend): fuse or fskit.
        """
        return self._kernel_mounts.add(prefix,
                                       mountpoint,
                                       session_id,
                                       backend=backend)

    def remove_fuse_mount(self,
                          prefix: str,
                          session_id: str | None = None) -> None:
        self._kernel_mounts.remove(prefix, session_id)

    @property
    def fuse_mountpoint(self) -> str | None:
        return self._kernel_mounts.mountpoint

    @property
    def fuse_mountpoints(self) -> dict[str, str]:
        return self._kernel_mounts.mountpoints

    def register_cli(self,
                     name: str,
                     spec: CLISpec,
                     config: dict[str, JsonValue] | None = None) -> CLIInstall:
        """Install a CLI under a head word, fully separate from mounts.

        Args:
            name (str): head word to install under (the dispatch key;
                two installs of one spec under different names are two
                accounts).
            spec (CLISpec): the program tree.
            config (dict[str, JsonValue] | None): installation config,
                validated through the spec's ``config_model`` (fail
                loud at install time).
        """
        return self._registry.clis.install(name, spec, config)

    def unregister_cli(self, name: str) -> None:
        """Remove an installed CLI; its head word stops resolving (127).

        Args:
            name (str): installed head word.
        """
        self._registry.clis.uninstall(name)

    def clis(self) -> dict[str, CLIInstall]:
        """Snapshot of the installed CLIs keyed by head word."""
        return self._registry.clis.items()

    def _sandbox_visible_mounts(self) -> list[str]:
        """The mount prefixes announced to sandboxed runtimes, read live.

        Two are withheld, and neither is withheld for being ``/``. An
        explicit root mount is forwarded like any other prefix, and a
        runtime that cannot serve it refuses on its own (pyodide does,
        because Emscripten already owns ``/``). What is withheld is the
        history view, which is a shell surface rather than a place to
        put files, and the synthetic root anchor, which nobody mounted:
        the workspace adds it so arg-less commands and root listing
        have somewhere to resolve, so announcing it as a mount would
        make every runtime report a claim on a resource the embedder
        never asked for (TS ``sandboxVisibleMounts``).
        """
        prefixes: list[str] = []
        for entry in self._registry.mounts():
            if entry.prefix in (HISTORY_PREFIX, HISTORY_PREFIX + "/"):
                continue
            if self._implicit_root and entry.prefix == "/":
                continue
            prefixes.append(entry.prefix)
        return prefixes

    def add_runtime(self, runtime: Runtime | str) -> Runtime:
        """Append a runtime entry to the workspace's ordered set.

        Args:
            runtime (Runtime | str): a Runtime instance or a registry
                runtime name (built like a config entry).

        Raises:
            ValueError: unknown name or duplicate entry.
        """
        return self._runtimes.add(runtime)

    @property
    def _cwd(self) -> str:
        return self._session_mgr.cwd

    @_cwd.setter
    def _cwd(self, value: str) -> None:
        self._session_mgr.cwd = value

    @property
    def env(self) -> Mapping[str, str]:
        return self._session_mgr.env

    @env.setter
    def env(self, value: dict[str, str]) -> None:
        self._session_mgr.env = value

    @property
    def file_prompt(self) -> str:
        return build_file_prompt(self._registry.mounts(),
                                 self._registry.clis.items())

    # ── lifecycle ───────────────────────────────────────────────────────────

    def __enter__(self) -> "Workspace":
        patch_process(self)
        return self

    def __exit__(self, exc_type: type[BaseException] | None,
                 exc_value: BaseException | None,
                 traceback: TracebackType | None) -> None:
        unpatch_process(self)
        run_async_from_sync(self.close(), self._vfs_loop)
        stop_vfs_loop(self)

    @property
    def registry(self) -> MountRegistry:
        """Mount table; consumed by the watch runtime."""
        return self._registry

    def attach_watch_runtime(self, runtime: WatchDelegate) -> None:
        """Install the watch runtime that ``watch`` delegates to.

        Only needed to customize the runtime; the default attaches
        lazily on first ``watch``/``notify``. The workspace closes it
        on ``close``.

        Args:
            runtime (WatchDelegate): Runtime to attach.

        Raises:
            RuntimeError: The workspace is closed, or a runtime is
                already attached.
        """
        if self._closed:
            raise RuntimeError("Workspace is closed")
        self._watch.attach(runtime)

    async def detach_watch_runtime(self) -> None:
        """Close and drop the attached watch runtime, if any.

        Active ``watch`` iterators finish cleanly. Afterwards the next
        ``watch``/``notify`` lazily attaches a fresh default runtime.
        """
        await self._watch.detach()

    def watch(
        self, path: str | PathSpec | Sequence[str | PathSpec]
    ) -> AsyncIterator[FileEvent]:
        """Stream externally observed changes under ``path``.

        The root's shape defines the depth, GNU shell glob style: a
        literal directory is its whole subtree, ``/dir/*`` is the
        entries at that level (shallow), ``/dir/*/`` is everything
        inside child directories. The default watch runtime attaches
        lazily on first use; call ``attach_watch_runtime`` beforehand
        only to customize it. The str tolerance lives only
        here, at the consumer boundary (mirroring ``Ops``); the
        runtime below is PathSpec-only.

        Args:
            path (str | PathSpec | Sequence[str | PathSpec]): Watch
                root or roots; plain strings are coerced. Each root
                may carry glob segments (``/nc/data/*.txt``).
        """
        raw = [path] if isinstance(path, (str, PathSpec)) else list(path)
        specs = [
            p if isinstance(p, PathSpec) else PathSpec.from_str_path(p)
            for p in raw
        ]
        if self._closed:
            raise RuntimeError("Workspace is closed")
        return self._watch.watch(specs)

    async def notify(self, change: FileEvent) -> None:
        """Inject one externally observed change into the watch
        runtime: invalidate its caches, then deliver it to every
        matching ``watch``.

        The single entry point for consumer-side detection (webhook
        receiver or poll loop over ``resource.delta_hook()``); see
        ``mirage.watch.Watcher.notify``.

        Args:
            change (FileEvent): Observed change.
        """
        if self._closed:
            raise RuntimeError("Workspace is closed")
        await self._watch.notify(change)

    async def close(self) -> None:
        await close_async(self)

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
            clis: CLIOverrides | None = None,
            secrets: Mapping[str, SecretSource | Mapping[str, Any]]
        | None = None,
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
            clis: {name: config} overrides for CLIs saved with
                redacted config secrets; a (spec, config) tuple also
                carries a live spec (how copy() shares directly
                installed programs).
            secrets: {instance: declaration} for the restored env
                pointers. A snapshot never carries the `secrets:` block
                (it is the deployment's credentials), so a pointer at a
                declared instance needs the block supplied here, the
                way a redacted mount needs `resources`.
            drift_policy: STRICT (default) raises on mismatch. OFF
                disables drift checking and evicts snapshot cache for
                fingerprinted paths.
        """
        return await cls.from_state(read_tar(source),
                                    resources=resources,
                                    clis=clis,
                                    secrets=secrets,
                                    drift_policy=drift_policy)

    @classmethod
    async def from_state(
            cls,
            state: dict[str, Any],
            *,
            resources: dict[str, Any] | None = None,
            clis: CLIOverrides | None = None,
            secrets: Mapping[str, SecretSource | Mapping[str, Any]]
        | None = None,
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
            clis: {name: config} overrides for CLIs saved with
                redacted config secrets; a (spec, config) tuple also
                carries a live spec (how copy() shares directly
                installed programs).
            secrets: {instance: declaration} for the restored env
                pointers; a snapshot never carries the `secrets:` block.
            drift_policy: STRICT (default) raises on mismatch. OFF
                disables drift checking and evicts snapshot cache for
                fingerprinted paths.
        """
        ws = await cls._from_state(state,
                                   resources=resources,
                                   clis=clis,
                                   secrets=secrets)
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
        """Duplicate this workspace, sharing only what cannot be rebuilt.

        See ``snapshot.api.snapshot`` for why remote backends are
        shared and local content resources are reconstructed fresh.
        """
        state = await to_state_dict(self)
        resources = reusable_resources(self._registry.mounts(), state)
        # The declarations travel with the copy the way a live CLI
        # install does: an env pointer restores from state naming its
        # instance, and without the block the copy would answer the
        # first read with "unknown secrets source".
        return await type(self)._from_state(state,
                                            resources=resources,
                                            clis=reusable_clis(self),
                                            secrets=self._declared_sources)

    @classmethod
    async def _from_state(
        cls,
        state: dict[str, Any],
        *,
        resources: dict[str, Any] | None = None,
        clis: CLIOverrides | None = None,
        secrets: Mapping[str, SecretSource | Mapping[str, Any]]
        | None = None
    ) -> "Workspace":
        args = build_mount_args(state, resources, clis)
        ws = cls(args.mount_args,
                 consistency=args.consistency,
                 session_id=args.default_session_id,
                 agent_id=args.default_agent_id,
                 clis=args.clis,
                 secrets=secrets)
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
        mounts: Mapping[str, MountMode | str] | None = None,
        *,
        profile: str | SessionProfile | Mapping[str, Any] | None = None,
        permissions: SessionProfile | Mapping[str, Any] | None = None,
    ) -> Session:
        """Create a session under one profile, with an optional inline
        document of its own.

        The profile is a name from the workspace's ``profiles``, or the
        workspace default when none is named, or a profile document.
        The inline ``permissions`` and ``mounts`` may add ask and deny
        rules, hides and weaker modes; they may never add an allow
        entry, which is the one rule about combining two documents.

        Args:
            session_id (str): unique id for the session.
            mounts (Mapping[str, MountMode | str] | None): sugar for
                ``permissions.mounts``: a mapping assigns each prefix a
                mode ("read", "write", "exec", or the filesystem aliases
                "r", "rw", "rwx"), which may only be weaker than the
                mount's own. A mount the mapping omits keeps its own
                mode, so this narrows and never confines; a profile
                that must keep a session away from a mount hides it.
            profile (str | SessionProfile | Mapping[str, Any] | None):
                the profile to create the session under: a name, a
                SessionProfile, or its plain document.
            permissions (SessionProfile | Mapping[str, Any] | None): an
                inline document of ask and deny rules and hides.

        Raises:
            PolicyError: an unknown profile name, or an inline document
                that states an allow list or a script.
        """
        if isinstance(profile, Mapping):
            profile = SessionProfile.model_validate(profile)
        base = self._base_profile(profile)
        inline = (SessionProfile.model_validate(permissions)
                  if permissions is not None else None)
        if mounts is not None:
            inline = with_inline(
                inline, SessionProfile.model_validate({"mounts": mounts}))
        compiled = compile_profile(with_inline(base, inline),
                                   self._profile_name(profile))
        check_cli_verbs(compiled.commands, self._cli_verbs())
        session = self._session_mgr.create(session_id)
        apply_profile(session, compiled)
        return session

    def _cli_verbs(self) -> dict[str, frozenset[str]]:
        """The verbs each installed CLI declares, keyed by head word.

        Read at ``create_session`` rather than at compile time because a
        CLI is registered on the workspace after it is built.
        """
        return {
            name:
            frozenset(child.name for child in (install.spec.subcommands or ()))
            for name, install in self._registry.clis.items().items()
        }

    def _base_profile(
            self,
            profile: str | SessionProfile | None) -> SessionProfile | None:
        """The base profile a session is created under, which the
        inline ``permissions``/``mounts`` arguments then layer onto:
        the profile as named, else the workspace default.

        Args:
            profile (str | SessionProfile | None): what the caller
                named, None for the workspace default.
        """
        if profile is None and self._default_profile_name is not None:
            return self._profiles[self._default_profile_name]
        return resolve_profile(self._profiles, profile)

    def _profile_name(self, profile: str | SessionProfile | None) -> str:
        """The name of the profile ``_base_profile`` resolves, which its
        script reads as ``ctx["profile"]`` and the session reports as
        its group; empty for a profile document passed without one.

        Args:
            profile (str | SessionProfile | None): what the caller
                named, None for the workspace default.
        """
        if isinstance(profile, str):
            return profile
        if profile is None and self._default_profile_name is not None:
            return self._default_profile_name
        if profile is None and DEFAULT_PROFILE in self._profiles:
            return DEFAULT_PROFILE
        return ""

    def _mount_prefixes(self) -> list[str]:
        """The mount prefixes a profile policy reads as
        ``ctx["mounts"]``, read per evaluation so a later mount shows.
        """
        return [entry.prefix for entry in self._registry.mounts()]

    def get_session(self, session_id: str) -> Session:
        return self._session_mgr.get(session_id)

    def list_sessions(self) -> list[Session]:
        return self._session_mgr.list()

    async def ensure_sessions_loaded(self) -> None:
        """Hydrate sessions from the session store (idempotent).

        The discovery record resolves first so a minted default session
        id can adopt the stored pointer before hydration keys off it.
        """
        await self._meta.ensure()
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
        return await self._meta.load()

    async def flush_sessions(self) -> None:
        """Persist every session's durable fields to the session store."""
        await self._session_mgr.flush()

    async def close_session(self, session_id: str) -> None:
        await self._session_mgr.close(session_id)

    async def close_all_sessions(self) -> None:
        await self._session_mgr.close_all()

    # ── mount management ────────────────────────────────────────────────────

    async def dispatch(self, op: str, path: PathSpec,
                       **kwargs: Any) -> tuple[Any, IOResult]:
        # The door owns pre-dispatch initialization (namespace load,
        # pending drift checks), so FUSE and the ops facade get it too.
        return await self._dispatcher.dispatch(op, path, **kwargs)

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

    @overload
    async def execute(
            self,
            command: str,
            session_id: str | None = ...,
            stdin: ByteSource | None = ...,
            provision: Literal[False] = ...,
            agent_id: str | None = ...,
            cwd: str | None = ...,
            env: dict[str, str] | None = ...,
            cancel: asyncio.Event | None = ...,
            record: bool = ...,
            runtime: str | None = ...,
            routing_decision: "RouteDecision | None" = ...) -> IOResult:
        ...

    @overload
    async def execute(
            self,
            command: str,
            session_id: str | None = ...,
            stdin: ByteSource | None = ...,
            *,
            provision: Literal[True],
            agent_id: str | None = ...,
            cwd: str | None = ...,
            env: dict[str, str] | None = ...,
            cancel: asyncio.Event | None = ...,
            record: bool = ...,
            runtime: str | None = ...,
            routing_decision: "RouteDecision | None" = ...) -> ProvisionResult:
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
        runtime: str | None = None,
        routing_decision: RouteDecision | None = None,
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
                need an unrecorded run. Nested lines inherit the typed
                line's routing decision and never re-route.
            runtime: Explicit runtime for this line, naming a workspace
                runtime entry. Stages the named runtime captures rebind
                to it for this line only (nested evals inherit it);
                everything else keeps its normal binding, so the
                argument overrides policy, never capability. Raises
                ValueError for a name that is not a workspace entry.
            routing_decision: Internal. The typed line's routing decision,
                forwarded by the executor's nested evals so inner
                lines never re-route.
        """
        return await execute_line(self, command, session_id, stdin, provision,
                                  agent_id, cwd, env, cancel, record, runtime,
                                  routing_decision)
