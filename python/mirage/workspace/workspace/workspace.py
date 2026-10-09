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
import dataclasses
import errno
import logging
import shutil
import tempfile
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import replace
from functools import partial
from pathlib import Path
from shlex import join as shell_join
from types import TracebackType
from typing import Any, Literal, overload

from pydantic import BaseModel

from mirage.bridge.sync import run_async_from_sync
from mirage.cache.file.config import CacheConfig
from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.index import IndexConfig
from mirage.commands.cli import CLISpec
from mirage.commands.cli.specs import cli_spec_for
from mirage.concurrency.limiter import run_blocking
from mirage.context import (
    get_current_session_for,
    get_current_session_unless_foreign,
    reset_current_session,
    reset_explaining,
    reset_program_invocation,
    reset_refusal_sink,
    session_visibility,
    set_current_session,
    set_explaining,
    set_program_invocation,
    set_refusal_sink,
)
from mirage.errors.fs import enoent
from mirage.io import IOResult
from mirage.io.config import IOConfig
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.observe.observer import Observer
from mirage.observe.record import OpRecord
from mirage.observe.store import ObserverStore
from mirage.policy import (
    AskHandler,
    Decisions,
    Deny,
    HandOff,
    Outcome,
    PermissionsPolicy,
    Policies,
    Policy,
    PolicyError,
    ScriptPolicy,
    SessionProfile,
    ShellExplanation,
)
from mirage.policy.builtin import PlacementPolicy
from mirage.policy.types import DryRun
from mirage.process.child import ChildProcess
from mirage.process.stdio import ProcessInput, ProcessOutput
from mirage.process.supervisor import ProcessSupervisor
from mirage.process.types import SpawnRequest
from mirage.process.view import ProcessView
from mirage.runtime.base import Runtime
from mirage.runtime.binding import (
    RuntimeContext,
    WorkspaceBinding,
    capture_binding,
)
from mirage.runtime.resolver import PrefixResolver
from mirage.runtime.routing import RouteDecision, RoutePolicy
from mirage.secrets.config import EnvVar, SecretSource
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import source_for
from mirage.secrets.sources import resolve_sources
from mirage.secrets.types import ResolvedSource
from mirage.shell import parse
from mirage.shell.bytes import decode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.console import Channel, JobConsole
from mirage.shell.constants import BIN_PREFIX
from mirage.shell.job_table import ConsoleFactory, JobTable
from mirage.shell.literal import literal_tree
from mirage.shell.variable import VarAttr
from mirage.types import (
    CacheFacts,
    DriftPolicy,
    FileEvent,
    FileStat,
    JsonValue,
    Limit,
    MountBackend,
    MountMode,
    PathSpec,
    ReadSpec,
    WritePolicy,
    parse_mount_mode,
)
from mirage.utils.abort import MirageAbortError, run_cancellable
from mirage.utils.hidden import path_visible
from mirage.utils.ids import new_session_id, new_workspace_id
from mirage.vfs.base import BaseVFS
from mirage.vfs.bin import BinViewVFS
from mirage.vfs.history import HISTORY_PREFIX, HistoryViewVFS
from mirage.vfs.s3.config import S3Config
from mirage.workspace.cli import CLIInstall
from mirage.workspace.dispatcher.dispatcher import Dispatcher
from mirage.workspace.documentation.documents import Documents
from mirage.workspace.execution import ExecutionScope
from mirage.workspace.executor.statement import restore_status
from mirage.workspace.expand.classify.path import classify_bare_path
from mirage.workspace.expand.globs import GlobOptions, resolve_globs
from mirage.workspace.files import Files
from mirage.workspace.lookup import lookup, program, program_note, programs
from mirage.workspace.lookup.types import Consumer
from mirage.workspace.mount import MountEntry, MountRegistry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.namespace.store import NamespaceStore
from mirage.workspace.mount.namespace.view import namespace_view_of
from mirage.workspace.mount.read_policy import check_read_capability
from mirage.workspace.mount.spec import Mount
from mirage.workspace.mount.write_policy import (
    check_write_capability,
    coerce_write_policy,
)
from mirage.workspace.node.explain import (
    explain_line,
    explained_line,
    holds,
)
from mirage.workspace.session import SessionManager, SessionState, SessionStore
from mirage.workspace.session.constants import DEFAULT_PROFILE
from mirage.workspace.session.resolve import (
    apply_profile,
    compile_profile,
    resolve_profile,
    with_inline,
)
from mirage.workspace.session.session import vars_from_entries, vars_from_env
from mirage.workspace.session.state import env_snapshot, session_view
from mirage.workspace.session.validate import check_cli_verbs
from mirage.workspace.shell_execution import ShellExecution
from mirage.workspace.snapshot import (
    DriftQueue,
    apply_state_dict,
    build_mount_args,
    install_fingerprints,
    read_snapshot,
    to_state_dict,
)
from mirage.workspace.snapshot import snapshot as _write_snapshot
from mirage.workspace.snapshot.config import index_config_dump
from mirage.workspace.snapshot.keys import StateKey
from mirage.workspace.snapshot.state import (
    CLIOverrides,
    reusable_clis,
    reusable_mounts,
)
from mirage.workspace.snapshot.utils import QUIESCE_SECONDS
from mirage.workspace.store import WorkspaceStateStore
from mirage.workspace.tools.file_version import FileVersionTracker
from mirage.workspace.tools.tool_operations import MirageToolOperations
from mirage.workspace.workspace.build import (
    resolve_control_stores,
    wire_runtime_world,
)
from mirage.workspace.workspace.cache import build_file_cache
from mirage.workspace.workspace.execute import (
    ExecuteEnv,
    LineFrame,
    execute_line,
)
from mirage.workspace.workspace.explainer import Explainer
from mirage.workspace.workspace.failure import placement_refused
from mirage.workspace.workspace.guard import reject_config_script
from mirage.workspace.workspace.kernel_mounts import KernelMounts
from mirage.workspace.workspace.lifecycle import (
    CloseDeps,
    Patched,
    close_workspace,
    patch_process,
    unpatch_process,
)
from mirage.workspace.workspace.meta import WorkspaceMeta
from mirage.workspace.workspace.mounts import (
    check_vfs,
    install_mounts,
    kernel_targets,
    normalize_mounts,
    prepare_added_mount,
)
from mirage.workspace.workspace.mounts import unmount as unmount_prefix
from mirage.workspace.workspace.types import VFSMount
from mirage.workspace.workspace.watch import WatchDelegate, WatchManager

logger = logging.getLogger(__name__)

# The stop event of the top-level line this context runs in, so a line
# that cancels its own session does not wait on itself.
LINE_STOP: ContextVar[asyncio.Event | None] = ContextVar(
    "mirage_line_stop", default=None
)

# Set inside a write the capture gate let through, so the ops it runs
# itself are not held behind it.
WRITE_HELD: ContextVar[bool] = ContextVar("mirage_write_held", default=False)


class Workspace:
    """Unified virtual filesystem over heterogeneous mounts.

    Manages mounts, caching, and command execution.
    All ops are forwarded directly to the resolved VFS.
    """

    def __init__(
        self,
        mounts: dict[str, VFSMount],
        cache_limit: str | int = "512MB",
        cache: CacheConfig | None = None,
        index: IndexConfig | None = None,
        mode: MountMode = MountMode.READ,
        read: ReadSpec | None = None,
        write: WritePolicy | str | None = None,
        command_limits: Mapping[str, Limit] | None = None,
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
        io: IOConfig | Mapping[str, Any] | None = None,
    ) -> None:
        self._registry = MountRegistry(
            IOConfig.model_validate({} if io is None else io)
        )
        self._registry.process_view = self._process_view
        self._registry.command_limits = dict(command_limits or {})
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
        self._workspace_id = (
            workspace_id if workspace_id is not None else new_workspace_id()
        )
        # A minted default session id is provisional: attaching to a
        # workspace whose discovery record already names one adopts the
        # stored pointer instead (see WorkspaceMeta).
        session_id_explicit = session_id is not None
        if session_id is None:
            session_id = new_session_id()
        stores = resolve_control_stores(
            self._workspace_id,
            store,
            owns_store,
            observe,
            namespace_store,
            session_store,
        )
        self._owns_state_store = stores.owned
        self._state_store = stores.state_store
        self._cache: FileCacheMixin = build_file_cache(cache, cache_limit)
        self._index_config = index
        self._closed = False
        self._closing = False
        self._async_closed = False
        self._state_dropped = False
        self._close_error: BaseException | None = None
        self._close_lock = asyncio.Lock()
        # mounts reused from another live workspace (copy() / load
        # VFS overrides) stay open here; their origin closes them.
        self._shared_mounts: set[int] = set()
        self._drift = DriftQueue()
        self.processes = ProcessSupervisor()
        self.job_table = JobTable(console_factory, self.processes)
        self._lines: dict[asyncio.Event, tuple[str | None, asyncio.Event]] = {}
        self._shell_executions: set[ShellExecution] = set()
        self._admitting = asyncio.Event()
        self._admitting.set()
        self._capture_lock = asyncio.Lock()
        self._admitted: set[asyncio.Event] = set()
        self._writes = 0
        self._writes_idle = asyncio.Event()
        self._writes_idle.set()
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
            raise SecretsError(
                "config `secrets` must be a mapping, got "
                f"{type(secrets).__name__}"
            )
        self._declared_sources: dict[str, SecretSource] = {
            name: (
                block
                if isinstance(block, SecretSource)
                else SecretSource.model_validate(block)
            )
            for name, block in (secrets or {}).items()
        }
        self._secret_sources_built: dict[str, ResolvedSource] | None = None
        self._secret_sources_task: (
            asyncio.Task[dict[str, ResolvedSource]] | None
        ) = None
        for block in self._declared_sources.values():
            source_for(block.source)
        seed_vars = vars_from_entries(env) if env else None
        for var in (seed_vars or {}).values():
            if (
                var.managed is not None
                and var.managed.source not in self._declared_sources
            ):
                source_for(var.managed.source)
        self._session_mgr = SessionManager(
            session_id, store=stores.sessions, seed_vars=seed_vars
        )
        self._tools: dict[str | None, MirageToolOperations] = {}
        self._reads: dict[str, FileVersionTracker] = {}
        # Admission policies, consulted in registration order after the
        # built-ins the registry seeds: the profile's admission rules
        # (PermissionsPolicy, reading each session's compiled rules
        # from the manager by the id the entry point puts in the context), the
        # profile's policy (ScriptPolicy, calling its hook per command
        # through the same manager), then Policy instances, then anything added
        # later through ws.policies.add(). The route policy
        # (route_policy=) is the line-level counterpart until it is
        # absorbed as a hook.
        self._registry.policies.add(PermissionsPolicy(self._session_mgr))
        # The entry points the runtime world attaches (below), so a profile
        # script reads the mounts an agent's program would, and through
        # the same gate. The link source is a lambda because the
        # namespace is built after this and read only at run time.
        self._sandbox_resolver = PrefixResolver(
            self._sandbox_visible_mounts,
            lambda directory: self._namespace.link_names_under(directory),
        )
        self._script_policy = ScriptPolicy(
            self._session_mgr,
            self._mount_prefixes,
            dispatch=self.dispatch,
            resolver=self._sandbox_resolver,
        )
        self._registry.policies.add(self._script_policy)
        for entry in policies or []:
            self._registry.policies.add(entry)
        # The ledger an Ask is taken to (design 3.9): records live on
        # the sessions, the host answers through `on_ask` (or just
        # records the question when none is wired) and reads
        # `ws.decisions`.
        self._registry.decisions = Decisions(self._session_mgr, on_ask)
        self._meta = WorkspaceMeta(
            self._workspace_id,
            self._state_store,
            self._session_mgr,
            session_id,
            session_id_explicit,
        )
        # The workspace-level default a mount overrides, as `mode` is.
        self._read_default = read if read is not None else ReadSpec()
        self._registry.set_default_read(self._read_default)
        self._write_default = coerce_write_policy(write)
        self._registry.set_default_write(self._write_default)
        self._registry.attach_file_cache(self._cache)
        # Only an explicit agent_id claims the workspace user; a bare
        # launch adopts whatever identity the namespace store holds.
        self._namespace = Namespace(
            self._registry, store=stores.namespace, user=agent_id
        )
        self._dispatcher = Dispatcher(
            self._namespace,
            self._cache,
            drift=self._drift,
            admit_write=self._admit_write,
        )
        self._registry.set_reconciler(self._dispatcher.reconciler)
        self._watch = WatchManager(self._registry)

        specs = normalize_mounts(
            mounts,
            mode,
            self._read_default,
            index,
            default_write=self._write_default,
            caching=self._cache.cache_limit > 0,
        )
        self._implicit_root = install_mounts(
            self._registry, specs, index, mode, self._read_default
        )
        # What the workspace and its mounts hide from every session,
        # stamped onto the default session now and onto every session
        # created or hydrated later.
        # The workspace's own session is a session created without a
        # name, so the default profile shapes it too: the primary agent
        # is not the one agent the document cannot reach.
        default_base = self._base_profile(None)
        self._session_mgr.default_profile = (
            compile_profile(default_base, self._profile_name(None))
            if default_base is not None
            else None
        )

        self.observer = Observer(store=stores.observe)
        # The stores this workspace's state lives in, whether the state
        # store built them or the caller passed one in directly: delete
        # clears these, not only what the state store would hand out.
        self._planes = (stores.namespace, stores.observe, stores.sessions)
        # Explicit at the construction site: the history view does not
        # cache reads, so its policy can only ever be bounded.
        self._registry.mount(
            HISTORY_PREFIX,
            HistoryViewVFS(self.observer),
            MountMode.READ,
            ReadSpec(),
            write=WritePolicy.UNCONDITIONAL,
        )
        # One file per program the session can run, where PATH finds it:
        # the same lookup which, type and command -v answer from.
        self._registry.mount(
            BIN_PREFIX,
            BinViewVFS(
                lambda: programs(self._call_session(), self._registry),
                lambda name: program_note(
                    name, self._call_session(), self._registry
                ),
            ),
            MountMode.READ,
            ReadSpec(),
            write=WritePolicy.UNCONDITIONAL,
        )
        # The facade delegates every op to the dispatcher, so FUSE and
        # programmatic ws.vfs walk the same pipeline as a shell command
        # and the policy gates fire exactly once, at that entry point. It runs
        # as the default session, as a bare ``shell`` does, so the
        # default profile confines it too.
        self._files = Files(
            self._registry.mount_rows(),
            observer=self.observer,
            agent_id=agent_id or "",
            links=self._namespace,
            dispatch=self._dispatcher.dispatch,
            bind=self._bind_session,
        )
        self._kernel_mounts = KernelMounts(self._files, self._session_mgr)
        self._documents = Documents(
            self._registry,
            self._files,
            self._session_mgr,
            lambda: (
                get_current_session_unless_foreign(self._session_mgr)
                or self._call_session()
            ),
            lambda name: compile_profile(self._base_profile(name), name),
            lambda: self.ensure_sessions_loaded(),
            lambda path: self.unmount(path),
            lambda path: self._namespace.follow_parent(path),
        )
        # Held only while the workspace is a context manager: what
        # lifecycle.patch_process replaced and the block's one loop.
        # Declared here, so an unpatch without a patch restores nothing.
        self._patched: list[Patched] = []
        self._vfs_loop: asyncio.AbstractEventLoop | None = None

        self._runtime_binding = WorkspaceBinding(
            self.dispatch,
            self._sandbox_resolver,
            lambda _binding: self.runtime_context(),
        )
        self._runtimes, self._router = wire_runtime_world(
            self._registry, self._runtime_binding, runtimes
        )
        reject_config_script("route_policy", route_policy)
        if route_policy is not None:
            self._registry.policies.place(
                PlacementPolicy(route_policy, lambda: self._runtimes.entries)
            )

        # Installed CLIs, fully separate from mounts: the YAML `clis:`
        # section arrives as {head: (spec key or tree, config)}; a spec
        # key resolves against the named registry and every entry
        # installs through the same fail-loud path as register_cli.
        if clis:
            for cli_name, (spec_or_key, cli_config) in clis.items():
                cli_spec = (
                    spec_or_key
                    if isinstance(spec_or_key, CLISpec)
                    else cli_spec_for(spec_or_key)
                )
                self._registry.clis.install(cli_name, cli_spec, cli_config)

        for prefix, target_backend, target_point in kernel_targets(specs):
            self.add_fuse_mount(prefix, target_point, backend=target_backend)

    async def history(self) -> list[dict[str, Any]]:
        """Command events recorded by the hidden recorder.

        Returns:
            list[dict]: All sessions' command events, timestamp order.
        """
        return await self.observer.command_events()

    async def explain(
        self, line: str, session_id: str = ""
    ) -> ShellExplanation:
        """What a line would do under a session's profile, without
        running any of it.

        The dry run of the gate every command passes through, so this
        and the refusal an agent would read come out of one place and
        cannot disagree. It runs no command, expands nothing, spends no
        grant and puts no question to a host, which is what makes it
        safe to call about a line nobody typed; a policy deciding it
        reads for real but changes nothing (``DryRun``). The line
        carries the verdict its result would, every answer at
        ``pre_execute`` and its parse tree, each command with every
        policy's answer to it and the runtime that would run it. A line
        a rule refuses, or that waits on the host, is never placed, as
        it is never placed when it runs, and a placement that refuses
        the line gives it the placement's refusal. A hidden path is no
        path to any of it. ``session.explain`` is the same dry run for
        each of a session's entry points.

        Host-side only. The structure of a profile's rules is an
        operator's business, so there is no builtin an agent can type
        to read it.

        Args:
            line (str): the line to judge, as an agent would type it.
            session_id (str): whose profile to judge it under; the
                default session when empty.

        Returns:
            ShellExplanation: the line's verdict and tree.
        """
        await self.ensure_sessions_loaded()
        # Judged inside a line, as the line runs: an ask a deciding
        # policy's read meets refuses like a deny and records nothing.
        sink_token = set_refusal_sink(lambda refusal: None)
        token = set_explaining(DryRun.DECIDING)
        try:
            return await self._explained(line, session_id)
        finally:
            reset_explaining(token)
            reset_refusal_sink(sink_token)

    async def _explained(self, line: str, session_id: str) -> ShellExplanation:
        """:meth:`explain`'s judging, run with its policies deciding.

        Args:
            line (str): the line to judge.
            session_id (str): whose profile to judge it under; the
                default session when empty.
        """
        session = self.get_session(session_id or self.default_session_id)
        ast = parse(line)
        judged = await explain_line(
            ast,
            session,
            self._registry,
            self._namespace,
            whole_line=self._runtimes.whole_line(None) is not None,
        )
        if holds([one.judgment for one in judged]):
            return explained_line(line, judged, lambda command: "")
        answers, placed = await self._router.placement(
            ast,
            line,
            session,
            session.session_id,
            self._default_agent_id or "",
        )
        if isinstance(placed, Deny):
            refused = placement_refused(placed, line)
            said = explained_line(line, judged, lambda command: "")
            return dataclasses.replace(
                said,
                answers=answers,
                outcome=Outcome.DENY,
                reason=placed.reason,
                source="",
                refusal=refused.refusal,
                exit_code=refused.exit_code,
                stderr=decode_text(await refused.materialize_stderr()),
            )
        said = explained_line(
            line,
            judged,
            lambda command: self._router.runtime_for(command, placed),
        )
        return dataclasses.replace(said, answers=answers)

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
                resolve_sources(self._declared_sources)
            )
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
    def vfs(self) -> Files:
        """The file API: read/write/stat/readdir/... against the mounts.

        Named as TypeScript names it (`ws.vfs`), so one host API reads the
        same in both languages.
        """
        return self._files

    @property
    def tools(self) -> MirageToolOperations:
        """The agent tools as the default session; ``Session.tools``
        for another."""
        return self._session_tools(None)

    def _session_tools(self, session_id: str | None) -> MirageToolOperations:
        """The one tool table a session has, made on first use.

        Every caller in the process shares it, so a file the agent read
        through one is guarded when it writes through another. Closing
        the session drops it. None is the default session as it is when
        each call runs, so its table keeps working when a snapshot load
        or an attach re-keys the default; an id stays that session.

        Args:
            session_id (str | None): the session, or None for the
                default.
        """
        tools = self._tools.get(session_id)
        if tools is None:
            tools = MirageToolOperations(Session(self, session_id))
            self._tools[session_id] = tools
        return tools

    async def _session_reads(
        self, session_id: str | None
    ) -> FileVersionTracker:
        """The read history the agent tools keep for one session.

        Every guarded table of the session shares it, the one following
        the default included, so a read through ``ws.tools`` guards a
        write through ``Session(ws, id).tools``. Sessions load first, so
        the default's id is final before it is looked up. Closing the
        session drops it, and a snapshot restore drops them all.

        Args:
            session_id (str | None): the session, or None for the
                default as it is now.
        """
        await self.ensure_sessions_loaded()
        sid = self.default_session_id if session_id is None else session_id
        reads = self._reads.get(sid)
        if reads is None:
            reads = FileVersionTracker(self.vfs._for_session(sid))
            self._reads[sid] = reads
        return reads

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
        """The host's entry point on asked commands: ``list()`` every record,
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

    @property
    def _shutting_down(self) -> bool:
        """Reject lifecycle changes while runtimes drain into open mounts."""
        return self._closing or self._closed

    def add_mount(
        self,
        prefix: str,
        vfs: BaseVFS,
        mode: MountMode = MountMode.READ,
        read: ReadSpec | None = None,
        vfs_ref: str | None = None,
        index: IndexConfig | None = None,
        write: WritePolicy | str | None = None,
    ) -> MountEntry:
        """Add a VFS to a running workspace, mirroring TS ``addMount``.

        The runtime entry point runs the same read-policy verdict the
        constructor does: a mount added here is no more able to declare
        a policy its backend cannot honour than one declared in YAML.

        Args:
            prefix (str): virtual mount point; duplicates are refused.
            vfs (BaseVFS): VFS providing commands and ops.
            mode (MountMode): access mode, read-only unless explicitly raised.
            read (ReadSpec | None): the mount's read policy; None takes
                the workspace default.
            vfs_ref (str | None): the ``vfs:`` value the driver was built
                from, recorded for snapshots; None for one built in code.
            index (IndexConfig | None): the mount's own index; None takes
                the workspace's. A VFS already mounted elsewhere keeps
                the index of that mount, as in the constructor, and this
                one goes unused.
            write (WritePolicy | str | None): the mount's write policy;
                None takes the workspace default. It is judged like the
                constructor's.

        Returns:
            MountEntry: the installed mount, with its normalized prefix.

        Raises:
            ValueError: the backend cannot honour the declared policy.
        """
        if self._shutting_down:
            raise RuntimeError("Workspace is closed")
        check_vfs(prefix, vfs)
        resolved_read = read if read is not None else self._read_default
        # An alias keeps the index of the VFS's other mount.
        alias = next(
            (m for m in self._registry.mounts() if m.vfs is vfs), None
        )
        own = index if index is not None else self._index_config
        check_read_capability(
            prefix,
            vfs,
            resolved_read,
            alias.index_config if alias is not None else own,
        )
        resolved_write = (
            coerce_write_policy(write)
            if write is not None
            else self._write_default
        )
        check_write_capability(
            prefix,
            vfs,
            resolved_write,
            mode,
            self._cache.cache_limit > 0 and vfs.caches_reads,
        )
        self._registry.check_vfs_available(vfs)
        previous = self._registry.mounts()
        entry = self._registry.mount(
            prefix,
            vfs,
            mode,
            resolved_read,
            write=resolved_write,
            index=own,
            vfs_ref=vfs_ref,
        )
        prepare_added_mount(self._registry, entry, previous)
        self._files.set_mounts(self._registry.mount_rows())
        return entry

    async def unmount(self, prefix: str) -> None:
        if self._shutting_down:
            raise RuntimeError("Workspace is closed")
        await unmount_prefix(
            self._registry,
            self._files,
            prefix,
            lambda: self._shutting_down,
            self._shared_mounts,
        )
        self._documents.views.pop(prefix.rstrip("/") or "/", None)

    def set_mount_mode(self, prefix: str, mode: MountMode) -> None:
        """Change an exact mount's ceiling, retaining data and session caps.

        Args:
            prefix (str): mount prefix, not a path inside a mount.
            mode (MountMode): the replacement read, write or exec mode.
        """
        if self._shutting_down:
            raise RuntimeError("Workspace is closed")
        mode = parse_mount_mode(mode)
        self._registry.mount_for_prefix(prefix).mode = mode
        self._files.set_mounts(self._registry.mount_rows())

    def add_fuse_mount(
        self,
        prefix: str,
        mountpoint: str | None = None,
        session_id: str | None = None,
        backend: str | MountBackend = MountBackend.FUSE,
    ) -> str:
        """Expose ``prefix`` at a real mountpoint and return its path.

        Args:
            prefix (str): the virtual prefix to expose.
            mountpoint (str | None): where to mount; None picks a path.
            session_id (str | None): session whose mount grants scope
                every op served through this mountpoint.
            backend (str | MountBackend): fuse or fskit.
        """
        return self._kernel_mounts.add(
            prefix, mountpoint, session_id, backend=backend
        )

    def remove_fuse_mount(
        self, prefix: str, session_id: str | None = None
    ) -> None:
        self._kernel_mounts.remove(prefix, session_id)

    @property
    def fuse_mountpoint(self) -> str | None:
        return self._kernel_mounts.mountpoint

    @property
    def fuse_mountpoints(self) -> dict[str, str]:
        return self._kernel_mounts.mountpoints

    def register_cli(
        self,
        name: str,
        spec: CLISpec,
        config: Mapping[str, JsonValue] | BaseModel | None = None,
    ) -> CLIInstall:
        """Install a CLI under a head word, fully separate from mounts.

        Args:
            name (str): head word to install under (the dispatch key;
                two installs of one spec under different names are two
                accounts).
            spec (CLISpec): the program tree.
            config (Mapping[str, JsonValue] | BaseModel | None):
                installation config: a mapping, validated through the
                spec's ``config_model`` (fail loud at install time), or
                an instance of that model.
        """
        if self._shutting_down:
            raise RuntimeError("Workspace is closed")
        return self._registry.clis.install(name, spec, config)

    def unregister_cli(self, name: str) -> None:
        """Remove an installed CLI; its head word stops resolving (127).

        Args:
            name (str): installed head word.
        """
        if self._shutting_down:
            raise RuntimeError("Workspace is closed")
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
        history and program views, which are shell surfaces rather than
        places to put files (a runtime has its own ``/usr/bin``), and the
        synthetic root anchor, which nobody mounted: the workspace adds it
        so arg-less commands and root listing have somewhere to resolve,
        so announcing it as a mount would make every runtime report a
        claim on a VFS the embedder never asked for (TS
        ``sandboxVisibleMounts``). A mount the bound session hides is
        withheld too: a runtime that builds its own tree from this list
        would otherwise show the hidden mount's name.
        """
        vis = session_visibility()
        prefixes: list[str] = []
        for entry in self._registry.mounts():
            if entry.prefix in (
                HISTORY_PREFIX,
                HISTORY_PREFIX + "/",
                BIN_PREFIX + "/",
            ):
                continue
            if self._implicit_root and entry.prefix == "/":
                continue
            if not path_visible(vis, entry.prefix.rstrip("/") or "/"):
                continue
            prefixes.append(entry.prefix)
        return prefixes

    def _call_session(self) -> SessionState:
        """The session an op runs under: the bound one, else the default."""
        return get_current_session_for(
            self._session_mgr
        ) or self._session_mgr.get(self._session_mgr.default_id)

    def runtime_context(self, session_id: str | None = None) -> RuntimeContext:
        """Capture local entry points for an adapter, scoped to one session.

        With no id, use this workspace's active session or its default.
        Calling a runtime directly remains a host API, outside shell admission.
        """
        session = (
            self._session_mgr.get(session_id)
            if session_id is not None
            else self._call_session()
        )
        token = set_current_session(session, self._session_mgr)
        try:
            return capture_binding(
                self._runtime_binding,
                ns=namespace_view_of(
                    self._registry, self._namespace, self.dispatch, session
                ),
                session_view=session_view(session, self.policies),
                processes=self._process_view(session),
                cwd=PathSpec.from_str_path(session.cwd),
                env=env_snapshot(session),
            )
        finally:
            reset_current_session(token)

    def spawn(
        self, request: SpawnRequest, session_id: str | None = None
    ) -> ChildProcess:
        """Spawn literal argv through admission in an isolated session fork.

        Args:
            request (SpawnRequest): program, arguments and launch overrides.
            session_id (str | None): host-selected session; defaults to
                the active session.
        """
        session = (
            self._session_mgr.get(session_id)
            if session_id is not None
            else self._call_session()
        )
        return self._spawn_for_session(request, session)

    def _process_view(self, session: SessionState) -> ProcessView:
        parent_pid = session.process_id
        view = self.processes.view(
            session.session_id, lambda: session.processes
        )

        def spawn(request: SpawnRequest) -> ChildProcess:
            view.check_spawn()
            child = session.fork(process_id=parent_pid)
            return self._spawn_for_session(request, child)

        return replace(view, spawn=spawn, depth=session.process_depth)

    def _spawn_for_session(
        self, request: SpawnRequest, session: SessionState
    ) -> ChildProcess:
        if self._closing or self._closed:
            raise RuntimeError("Workspace is closed")
        if session.process_depth >= 16:
            raise RuntimeError("process nesting limit (16) reached")
        argv = tuple(request.argv)
        literal_tree(argv)
        head = argv[0]
        name = (
            head[len(BIN_PREFIX) + 1 :]
            if head.startswith(BIN_PREFIX + "/")
            else head
        )
        if "/" not in name:
            if (
                program(name, session, self._registry) is None
                and lookup(name, session, self._registry) != Consumer.EXTERNAL
            ):
                raise enoent(head)
            argv = (name, *argv[1:])
        cwd = request.cwd or PathSpec.from_str_path(session.cwd)
        inherited_env = {} if request.replace_env else env_snapshot(session)
        child = session.fork(
            cwd=cwd.virtual,
            vars=vars_from_env(inherited_env),
            functions={},
            process_depth=session.process_depth + 1,
        )
        if "PWD" not in inherited_env:
            child.vars["PWD"] = replace(child.vars["PWD"], attrs=frozenset())
        child.aliases = {}
        # The child's stdout is its handle's result, as a typed line's is
        # the terminal, so the command limits bound what it hands back
        # wherever the parent's own output goes.
        child.terminal_output = True
        input_stream, output = (
            ProcessInput(self.io.buffer_bytes),
            ProcessOutput(request.merge_stderr, self.io.buffer_bytes),
        )
        env = dict(request.env) if request.env is not None else None
        owner = self._session_mgr.get(session.session_id)
        admission = self.processes.view(
            session.session_id, lambda: owner.processes
        )

        async def run() -> int:
            await self.ensure_sessions_loaded()
            if self._session_mgr.get(session.session_id) is not owner:
                raise RuntimeError(
                    "session changed during hydration; retry spawn after "
                    "ensure_sessions_loaded"
                )
            admission.check_spawn()
            token = set_current_session(child, self._session_mgr)
            program_token = set_program_invocation(child)
            try:
                view = session_view(child, self.policies)
                for name, value in (env or {}).items():
                    await view.set(name, value)
                    await view.mark(name, VarAttr.EXPORT, True)
                result = await execute_line(
                    self._execute_env(),
                    shell_join(argv),
                    child.session_id,
                    input_stream.stream(),
                    agent_id=None,
                    cwd=None,
                    env=None,
                    cancel=None,
                    record=True,
                    runtime=None,
                    routing_decision=None,
                    argv=argv,
                    sink=output,
                )
                await output.emit(
                    Channel.STDOUT, await materialize(result.stdout)
                )
                await output.emit(
                    Channel.STDERR, await materialize(result.stderr)
                )
                return result.exit_code
            finally:
                reset_program_invocation(program_token)
                reset_current_session(token)
                input_stream.stop()
                output.end()

        process = self.processes.start(
            session_id=child.session_id,
            command=shell_join(argv),
            cwd=cwd,
            run=run,
            parent_pid=session.process_id,
            limit=session.processes.max,
        )
        child.process_id = process.info.pid
        child.shell_pid = process.info.pid

        def cancel() -> None:
            process.terminate()
            self.processes.terminate_children(process.info.pid)
            input_stream.stop()
            output.stop()

        return ChildProcess(process, input_stream, output, cancel)

    def runtimes(self) -> list[Runtime]:
        """The ordered runtime world, first capturer first."""
        return list(self._runtimes.entries)

    def add_runtime(self, runtime: Runtime | str) -> Runtime:
        """Append a runtime entry to the workspace's ordered set.

        Args:
            runtime (Runtime | str): a Runtime instance or a registry
                runtime name (built like a config entry).

        Raises:
            ValueError: unknown name or duplicate entry.
        """
        if self._shutting_down:
            raise RuntimeError("Workspace is closed")
        return self._runtimes.add(runtime)

    async def remove_runtime(self, name: str) -> None:
        """Remove a runtime entry, closing it once its runs finish.

        Args:
            name (str): the entry's name; ``workspace`` is permanent.
        """
        if self._shutting_down:
            raise RuntimeError("Workspace is closed")
        await self._runtimes.remove(name)

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

    async def vfs_md(
        self,
        path: str | PathSpec | None = None,
        *,
        profile: str | None = None,
        session_id: str | None = None,
    ) -> str:
        """Render VFS Markdown, optionally exposing a live file in the workspace.

        Args:
            path (str | PathSpec | None): existing-parent virtual destination.
            profile (str | None): named profile preview; requires no path or session.
            session_id (str | None): session scope, otherwise workspace-wide exposure.
        """
        return await self._documents.get("vfs", path, profile, session_id)

    async def skill_md(
        self,
        path: str | PathSpec | None = None,
        *,
        profile: str | None = None,
        session_id: str | None = None,
    ) -> str:
        """Render a self-contained CLI skill, optionally exposing a live file.

        Args:
            path (str | PathSpec | None): existing-parent virtual destination.
            profile (str | None): named profile preview; requires no path or session.
            session_id (str | None): session scope, otherwise workspace-wide exposure.
        """
        return await self._documents.get("skill", path, profile, session_id)

    # ── lifecycle ───────────────────────────────────────────────────────────

    def __enter__(self) -> "Workspace":
        self._vfs_loop = asyncio.new_event_loop()
        self._patched = patch_process(self._files, self._vfs_loop)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        unpatch_process(self._patched)
        self._patched = []
        run_async_from_sync(self.close(), self._vfs_loop)
        # Closed after the workspace close, which ran on it.
        loop, self._vfs_loop = self._vfs_loop, None
        if loop is not None:
            loop.close()

    @property
    def io(self) -> IOConfig:
        """Limits shared by this workspace's streaming queues."""
        return self._registry.io

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
        if self._shutting_down:
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
        here, at the consumer boundary (mirroring ``Files``); the
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
        if self._shutting_down:
            raise RuntimeError("Workspace is closed")
        return self._watch.watch(specs)

    async def notify(self, change: FileEvent) -> None:
        """Inject one externally observed change into the watch
        runtime: invalidate its caches, then deliver it to every
        matching ``watch``.

        The single entry point for consumer-side detection (webhook
        receiver or poll loop over ``VFS.delta_hook()``); see
        ``mirage.watch.Watcher.notify``.

        Args:
            change (FileEvent): Observed change.
        """
        if self._shutting_down:
            raise RuntimeError("Workspace is closed")
        await self._watch.notify(change)

    async def close(self) -> None:
        await self._close(drop_state=False)

    async def delete(self) -> None:
        """Close the workspace and delete its state from the store.

        Links, history, sessions and the metadata record all go, so a
        workspace created later under this id starts empty. ``close``
        keeps them, which is how a daemon's workspace survives a restart.

        Raises:
            RuntimeError: the workspace was closed first, which closed
                the stores its state lives in, so nothing was deleted.
        """
        await self._close(drop_state=True)
        if not self._state_dropped:
            raise RuntimeError(
                "workspace was closed before delete; its state is kept"
            )

    async def _close(self, drop_state: bool) -> None:
        """Release everything the workspace owns, exactly once
        (``close_workspace``); a later call answers as the first did.

        Args:
            drop_state (bool): delete the workspace's state from its
                store once nothing writes it any more, before the store
                closes.
        """
        # Stop lifecycle mutations before teardown yields or captures its
        # close lists. Keep _closed separate so runtime journals can still
        # dispatch.
        self._closing = True
        executions = list(self._shell_executions)
        for execution in executions:
            execution.cancel()
        await asyncio.gather(*(execution.aclose() for execution in executions))
        async with self._close_lock:
            if self._async_closed:
                if self._close_error is not None:
                    raise self._close_error
                return
            self._state_dropped = drop_state
            failures = await close_workspace(self._close_deps(drop_state))
            self._closed = True
            self._async_closed = True
            if failures:
                self._close_error = (
                    failures[0]
                    if len(failures) == 1
                    else BaseExceptionGroup(
                        "workspace teardown failed", failures
                    )
                )
                raise self._close_error

    def _close_deps(self, drop_state: bool) -> CloseDeps:
        """What closing releases (``close_workspace``).

        Args:
            drop_state (bool): delete the workspace's state too.
        """
        return CloseDeps(
            sessions=self._session_mgr,
            watch=self._watch,
            cache=self._cache,
            owns_state_store=self._owns_state_store,
            state_store=self._state_store,
            closers=[self._script_policy.close, self._runtimes.close],
            job_table=self.job_table,
            processes=self.processes,
            registry=self._registry,
            shared_mounts=self._shared_mounts,
            kernel_mounts=self._kernel_mounts,
            drop_state=drop_state,
            workspace_id=self.workspace_id,
            planes=self._planes,
        )

    # ── snapshot / load / copy ─────────────────────────────────────────────

    async def snapshot(
        self,
        target,
        *,
        compress: str | None = None,
        s3: S3Config | None = None,
    ) -> int:
        """Serialize this workspace to a tar.

        Captured:
            * Mount configs, sessions, history, finished jobs.
            * Cache bytes for fast replay.
            * One fingerprint entry per remote read (ETag-equivalent,
              plus a backend-specific ``revision`` when the VFS
              exposes one — e.g. S3 ``VersionId``).

        NOT captured:
            * Live state of mounts with ``supports_snapshot=False``
              (Gmail, Slack, Linear, etc.). Load logs a warning naming
              them.
            * Files the agent never touched.
            * Bytes of remote objects. Recovery of original bytes works
              only when the VFS accepts a revision pin (S3 family
              today) and the recorded revision still exists on the
              source.

        Async because fingerprint capture stats each touched path on a
        ``supports_snapshot`` mount.

        Args:
            target: filesystem path OR a writable file-like object; with
                ``s3``, the object key.
            compress: None | "gz" | "bz2" | "xz".
            s3 (S3Config | None): an S3-like store to put the tar in.

        Returns:
            int: the tar's size in bytes.
        """
        return await _write_snapshot(self, target, compress=compress, s3=s3)

    @classmethod
    async def load(
        cls,
        source,
        *,
        mounts: dict[str, Any] | None = None,
        clis: CLIOverrides | None = None,
        secrets: Mapping[str, SecretSource | Mapping[str, Any]] | None = None,
        drift_policy: DriftPolicy = DriftPolicy.STRICT,
        s3: S3Config | None = None,
    ) -> "Workspace":
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
           check and drops the restored RAM cache entries so reads
           serve current state (a Redis cache is never restored from
           a snapshot, so there is nothing to drop).

        Drift check is eager (fires once on the first dispatch or
        execute), so downstream code can rely on consistent state.

        Args:
            source: filesystem path OR a readable file-like object; with
                ``s3``, the object key.
            mounts: {prefix: VFS} overrides for mounts saved
                with redacted creds.
            clis: {name: config} overrides for CLIs saved with
                redacted config secrets; a (spec, config) tuple also
                carries a live spec (how copy() shares directly
                installed programs).
            secrets: {instance: declaration} for the restored env
                pointers. A snapshot never carries the `secrets:` block
                (it is the deployment's credentials), so a pointer at a
                declared instance needs the block supplied here, the
                way a redacted mount needs `mounts`.
            drift_policy: STRICT (default) raises on mismatch. OFF
                disables drift checking and drops the restored RAM
                cache entries for fingerprinted paths; a Redis cache is
                never restored from a snapshot, so it has nothing to
                drop.
            s3 (S3Config | None): the S3-like store the tar is in.
        """
        # Disk mount files are staged on disk, not held in memory, until
        # the restored mounts have copied them in.
        staging = Path(
            await run_blocking(tempfile.mkdtemp, prefix="mirage-restore-")
        )
        try:
            return await cls.from_state(
                await read_snapshot(source, s3=s3, staging=staging),
                mounts=mounts,
                clis=clis,
                secrets=secrets,
                drift_policy=drift_policy,
            )
        finally:
            await run_blocking(shutil.rmtree, staging, ignore_errors=True)

    @classmethod
    async def from_state(
        cls,
        state: dict[str, Any],
        *,
        mounts: dict[str, Any] | None = None,
        clis: CLIOverrides | None = None,
        secrets: Mapping[str, SecretSource | Mapping[str, Any]] | None = None,
        drift_policy: DriftPolicy = DriftPolicy.STRICT,
    ) -> "Workspace":
        """Reconstruct a Workspace directly from a state dict (no tar).

        The in-process inverse of ``to_state_dict``: build the mounts,
        restore content/cache/history, then install drift fingerprints.
        ``load`` is this plus a tar read; callers that already hold a
        state dict (e.g. a version checkout) should use this and skip the
        tar round-trip.

        Args:
            state: a state dict from ``to_state_dict`` or a version.
            mounts: {prefix: VFS} overrides for mounts saved
                with redacted creds.
            clis: {name: config} overrides for CLIs saved with
                redacted config secrets; a (spec, config) tuple also
                carries a live spec (how copy() shares directly
                installed programs).
            secrets: {instance: declaration} for the restored env
                pointers; a snapshot never carries the `secrets:` block.
            drift_policy: STRICT (default) raises on mismatch. OFF
                disables drift checking and drops the restored RAM
                cache entries for fingerprinted paths; a Redis cache is
                never restored from a snapshot, so it has nothing to
                drop.
        """
        ws = await cls._from_state(
            state, mounts=mounts, clis=clis, secrets=secrets
        )
        install_fingerprints(
            ws._registry,
            ws._cache,
            ws._drift,
            state.get(StateKey.FINGERPRINTS) or [],
            drift_policy,
        )
        live_only = state.get(StateKey.LIVE_ONLY_MOUNTS) or []
        if live_only:
            logger.warning(
                "Workspace.from_state: %s mount(s) opt out of snapshot "
                "replay; reads against them will serve current state with "
                "no drift detection: %s",
                len(live_only),
                live_only,
            )
        return ws

    async def copy(self) -> "Workspace":
        """Duplicate this workspace, sharing only what cannot be rebuilt.

        See ``snapshot.api.snapshot`` for why remote backends are
        shared and local content mounts are reconstructed fresh.
        """
        async with self._quiesced():
            return await self._copy()

    async def _copy(self) -> "Workspace":
        state = await to_state_dict(self)
        for mount in self._registry.mounts():
            for saved in state["mounts"]:
                if saved["prefix"] == mount.prefix:
                    saved["index_config"] = index_config_dump(
                        mount.index_config, reveal=True
                    )
        mounts = reusable_mounts(self._registry.mounts(), state)
        # The declarations travel with the copy the way a live CLI
        # install does: an env pointer restores from state naming its
        # instance, and without the block the copy would answer the
        # first read with "unknown secrets source". Profiles and
        # command limits are deployment config the state dict never
        # carries; without them the copy runs every session unconfined.
        # Policy instances and the route policy stay behind: a policy
        # is a live host object whose state two workspaces must not
        # share, and the route names runtimes the copy does not carry.
        return await type(self)._from_state(
            state,
            mounts=mounts,
            clis=reusable_clis(self),
            secrets=self._declared_sources,
            command_limits=self._registry.command_limits,
            profiles=self._profiles,
            profile=self._default_profile_name,
        )

    @classmethod
    async def _from_state(
        cls,
        state: dict[str, Any],
        *,
        mounts: dict[str, Any] | None = None,
        clis: CLIOverrides | None = None,
        secrets: Mapping[str, SecretSource | Mapping[str, Any]] | None = None,
        command_limits: Mapping[str, Limit] | None = None,
        profiles: Mapping[str, SessionProfile] | None = None,
        profile: str | None = None,
    ) -> "Workspace":
        args = build_mount_args(state, mounts, clis)
        # No read= here: each restored Mount carries its own spec, and
        # its own mode, so `mode` reaches only the scratch root the
        # workspace adds again.
        ws = cls(
            args.mount_args,
            io=IOConfig.model_validate(state.get("io", {})),
            mode=args.anchor_mode or MountMode.READ,
            write=args.write_default,
            session_id=args.default_session_id,
            agent_id=args.default_agent_id,
            clis=args.clis,
            secrets=secrets,
            command_limits=command_limits,
            profiles=profiles,
            profile=profile,
        )
        if mounts:
            ws._shared_mounts = {
                id(r.vfs if isinstance(r, Mount) else r)
                for r in mounts.values()
            }
        await apply_state_dict(ws, state)
        return ws

    def __deepcopy__(self, memo) -> "Workspace":
        raise NotImplementedError(
            "Workspace.copy is async (it captures fingerprints for replay). "
            "Call `await ws.copy()` directly instead of `copy.deepcopy(ws)`."
        )

    def __copy__(self) -> "Workspace":
        raise NotImplementedError(
            "Workspace has no useful shallow copy — use `await ws.copy()`."
        )

    # ── session lifecycle ──────────────────────────────────────────────────

    def create_session(
        self,
        session_id: str,
        mounts: Mapping[str, MountMode | str] | None = None,
        *,
        profile: str | SessionProfile | Mapping[str, Any] | None = None,
        permissions: SessionProfile | Mapping[str, Any] | None = None,
    ) -> SessionState:
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
        inline = (
            SessionProfile.model_validate(permissions)
            if permissions is not None
            else None
        )
        if mounts is not None:
            inline = with_inline(
                inline, SessionProfile.model_validate({"mounts": mounts})
            )
        compiled = compile_profile(
            with_inline(base, inline), self._profile_name(profile)
        )
        check_cli_verbs(compiled.policies.commands, self._cli_verbs())
        session = self._session_mgr.create(session_id)
        apply_profile(session, compiled)
        return session

    async def session(
        self,
        session_id: str,
        mounts: Mapping[str, MountMode | str] | None = None,
        *,
        profile: str | SessionProfile | Mapping[str, Any] | None = None,
        permissions: SessionProfile | Mapping[str, Any] | None = None,
    ) -> "Session":
        """One session's two entry points: ``shell`` and ``vfs`` bound to it.

        Creates the session under the given profile when the id is new
        (the same call as ``create_session``), and adopts it as is when
        it exists. A profile, mounts or permissions for an existing
        session are refused rather than ignored: a profile is set once,
        at creation, and the object it returns must not look like it narrowed a
        session it merely adopted. The session store is hydrated
        first, so a session a previous process persisted is adopted
        with its stored profile rather than recreated over it; that is
        why this is a coroutine where ``create_session`` is not.

        Args:
            session_id (str): the session's id.
            mounts (Mapping[str, MountMode | str] | None): per-mount
                modes, as ``create_session`` takes them.
            profile (str | SessionProfile | Mapping[str, Any] | None):
                the profile to create the session under.
            permissions (SessionProfile | Mapping[str, Any] | None): an
                inline document of ask and deny rules and hides.

        Raises:
            ValueError: the session exists and a profile, mounts or
                permissions were given.
        """
        await self.ensure_sessions_loaded()
        if any(s.session_id == session_id for s in self._session_mgr.list()):
            if (
                mounts is not None
                or profile is not None
                or permissions is not None
            ):
                raise ValueError(
                    f"session {session_id!r} exists; its "
                    "profile was set when it was created"
                )
            return Session(self, session_id)
        self.create_session(
            session_id, mounts, profile=profile, permissions=permissions
        )
        return Session(self, session_id)

    def _cli_verbs(self) -> dict[str, frozenset[str]]:
        """The verbs each installed CLI declares, keyed by head word.

        Read at ``create_session`` rather than at compile time because a
        CLI is registered on the workspace after it is built.
        """
        return {
            name: frozenset(
                child.name for child in (install.spec.subcommands or ())
            )
            for name, install in self._registry.clis.items().items()
        }

    def _base_profile(
        self, profile: str | SessionProfile | None
    ) -> SessionProfile | None:
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

    def get_session(self, session_id: str) -> SessionState:
        return self._session_mgr.get(session_id)

    async def set_session_profile(
        self,
        session_id: str,
        profile: str | SessionProfile | Mapping[str, Any] | None,
    ) -> SessionState:
        """Replace a live session's permissions, including its policy runtime.

        Compilation succeeds before anything changes. This replaces modes,
        hides, shows and policy rules; cwd/env presets apply only at creation.
        Existing cwd, variables, functions and history survive. This is a
        host-side operation, like creating a session.

        Args:
            session_id (str): the session to update.
            profile: named profile or complete document; None selects the
                workspace default, and an empty document clears restrictions.
        """
        if self._shutting_down:
            raise RuntimeError("Workspace is closed")
        if isinstance(profile, Mapping):
            profile = SessionProfile.model_validate(profile)
        compiled = compile_profile(
            self._base_profile(profile), self._profile_name(profile)
        )
        check_cli_verbs(compiled.policies.commands, self._cli_verbs())
        was_default = session_id == self.default_session_id
        await self.ensure_sessions_loaded()
        if self._shutting_down:
            raise RuntimeError("Workspace is closed")
        if was_default:
            session_id = self.default_session_id
        session = await self._session_mgr.set_profile(session_id, compiled)
        self.processes.revoke_session(session_id)
        return session

    def list_sessions(self) -> list[SessionState]:
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

    async def _adopt_default_session(self, session_id: str) -> None:
        """Snapshot restore: adopt the snapshot's default session identity
        and point the discovery record at it.

        Args:
            session_id (str): the snapshot's default session.
        """
        await self._meta.adopt_default(session_id)

    def _forget_reads(self) -> None:
        """Snapshot restore: every session the snapshot restores is a new
        one to the agent tools, so none keeps what was read before."""
        self._reads.clear()

    async def workspace_meta(self) -> dict[str, Any]:
        """This workspace's metadata record (discovery surface)."""
        return await self._meta.load()

    async def flush_sessions(self) -> None:
        """Persist every session's durable fields to the session store."""
        await self._session_mgr.flush()

    async def cancel(self, session_id: str | None = None) -> int:
        """Cancel the top-level lines running or queued in a session.

        What Ctrl-C does to a foreground line, for every entry point at once:
        HTTP jobs, SSH and codex lines and SDK callers alike end with
        ``MirageAbortError``, their ``$?`` left as they found it. Returns
        once those lines have ended, so the session is quiet; a line
        cancelling its own session is stopped but not waited for.

        Args:
            session_id (str | None): the session, or None for every
                session.

        Returns:
            int: how many lines were cancelled.
        """
        default = self._session_mgr.default_id
        own = LINE_STOP.get()
        hit = [
            (stop, ended)
            for stop, (named, ended) in list(self._lines.items())
            if session_id is None or (named or default) == session_id
        ]
        cancelled = sum(1 for stop, _ in hit if not stop.is_set())
        for stop, _ in hit:
            stop.set()
        await asyncio.gather(
            *(ended.wait() for stop, ended in hit if stop is not own)
        )
        return cancelled

    @asynccontextmanager
    async def _quiesced(
        self, seconds: float = QUIESCE_SECONDS
    ) -> AsyncIterator[None]:
        """Hold new top-level lines and let the running ones end.

        A capture (a snapshot, a copy, a clone) reads disk files after
        its state names them, so it runs here: what it reads is the
        revision the lines left. Lines still running after ``seconds``
        answer EBUSY; cancel them first to capture at once. The caller's
        own line is not waited for, and captures take turns.

        Args:
            seconds (float): how long to wait for running lines.
        """
        async with self._capture_lock:
            own = LINE_STOP.get()
            self._admitting.clear()
            try:
                waiters = [
                    asyncio.ensure_future(ended.wait())
                    for stop, (_, ended) in self._lines.items()
                    if stop in self._admitted and stop is not own
                ]
                if self._writes:
                    waiters.append(
                        asyncio.ensure_future(self._writes_idle.wait())
                    )
                if waiters:
                    _, pending = await asyncio.wait(waiters, timeout=seconds)
                    for waiter in pending:
                        waiter.cancel()
                    if pending:
                        raise OSError(
                            errno.EBUSY,
                            f"workspace busy: {len(pending)} line(s) or "
                            "write(s) still running",
                        )
                yield
            finally:
                self._admitting.set()

    async def _admit_line(
        self, stop: asyncio.Event, cancel: asyncio.Event | None
    ) -> None:
        """Hold a top-level line while a capture reads, then let it in.

        The line is already listed, so ``cancel`` reaches it while it
        waits; a capture waits only for lines let in.

        Args:
            stop (asyncio.Event): the line's own stop.
            cancel (asyncio.Event | None): the caller's abort event.
        """
        while not self._admitting.is_set():
            await run_cancellable(self._admitting.wait(), cancel, stop)
        self._admitted.add(stop)

    @asynccontextmanager
    async def _admit_write(self) -> AsyncIterator[None]:
        """Hold a write while a capture reads, unless its line is waited for.

        A write from a running top-level line passes: the capture waits
        for that line. Any other (an entry point's file op, SFTP, FUSE, a
        background job) waits for the capture to finish, and counts as
        under way until it ends, so a capture that starts waits it out.
        """
        if WRITE_HELD.get() or LINE_STOP.get() in self._admitted:
            yield
            return
        while not self._admitting.is_set():
            await self._admitting.wait()
        self._writes += 1
        self._writes_idle.clear()
        token = WRITE_HELD.set(True)
        try:
            yield
        finally:
            WRITE_HELD.reset(token)
            self._writes -= 1
            if self._writes == 0:
                self._writes_idle.set()

    async def kill(self, session_id: str | None = None) -> int:
        """Kill the background jobs and runners a session started.

        What ``kill`` does to ``cmd &`` jobs, leaving the session open;
        runners outside the job list (a runtime's spawned process) are
        stopped too.

        Args:
            session_id (str | None): the session, or None for every
                session.

        Returns:
            int: how many jobs and runners were stopped.
        """
        jobs = (
            self.job_table.all_running_jobs()
            if session_id is None
            else self.job_table.running_jobs(session_id)
        )
        killed = 0
        for job in jobs:
            if await self.job_table.kill(job.id, job.session_id):
                killed += 1
        for process in self.processes.live():
            if session_id in (None, process.info.session_id):
                if process.terminate():
                    killed += 1
        return killed

    async def close_session(self, session_id: str) -> None:
        # The manager refuses the default and an unknown id first; a
        # session that did close takes its jobs with it, so a later
        # session reusing the id inherits nothing. Its lines are
        # cancelled first, as a hangup ends a terminal's foreground job.
        if session_id != self._session_mgr.default_id:
            await self.cancel(session_id)
        await self._session_mgr.close(session_id)
        await self._documents.release_session(session_id)
        await self.job_table.close_session(session_id)
        self._tools.pop(session_id, None)
        self._reads.pop(session_id, None)

    async def close_all_sessions(self) -> None:
        closed = [
            s.session_id
            for s in self.list_sessions()
            if s.session_id != self.default_session_id
        ]
        await self._session_mgr.close_all()
        for session_id in closed:
            await self._documents.release_session(session_id)
            await self.job_table.close_session(session_id)
            self._tools.pop(session_id, None)
            self._reads.pop(session_id, None)

    # ── mount management ────────────────────────────────────────────────────

    async def _bind_session(
        self, session_id: str | None, run: Callable[[], Awaitable[Any]]
    ) -> Any:
        """Run one dispatcher call as ``session_id``.

        A session already bound in this context is kept: a command's
        runtime reaching ``ws.vfs`` stays in its own session, and a
        kernel mount serving one session keeps that one, so the entry point
        never widens a caller's view. A session another workspace
        bound is the exception: its hides and grants describe that
        workspace, so an embedder callback reaching this entry point from
        inside the other's line runs as the session it asked for,
        judged by this workspace's own profile. Otherwise the named
        session is bound the way ``shell`` binds it.

        Args:
            session_id (str | None): the session to run as when none is
                bound; None for the default session as it is now.
            run (Callable[[], Awaitable[Any]]): the dispatcher call.
        """
        if get_current_session_unless_foreign(self._session_mgr) is not None:
            return await run()
        # The full hydration path, discovery record first: a workspace
        # attached to a shared store adopts the persisted default
        # session's id there, and binding before that would run as a
        # freshly minted, unrestricted default instead.
        await self.ensure_sessions_loaded()
        if session_id is None:
            session_id = self._session_mgr.default_id
        token = set_current_session(
            self._session_mgr.get(session_id), owner=self._session_mgr
        )
        try:
            return await run()
        finally:
            reset_current_session(token)

    async def dispatch(
        self, name: str, path: PathSpec, /, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        # The dispatcher owns pre-dispatch initialization (namespace load,
        # pending drift checks), so FUSE and `ws.vfs` get it too.
        # Runs as the default session unless one is bound, like ws.vfs.
        return await self._bind_session(
            None, partial(self._dispatcher.dispatch, name, path, **kwargs)
        )

    async def stat(self, path: str) -> FileStat:
        scope = PathSpec(
            virtual=path, directory=path, vfs_path="", resolved=True
        )
        result, _ = await self.dispatch("stat", scope)
        return result

    async def readdir(self, path: str) -> list[str]:
        scope = PathSpec(
            virtual=path, directory=path, vfs_path="", resolved=False
        )
        raw, _ = await self.dispatch("readdir", scope)
        return raw

    async def glob(
        self, pattern: str, *, session_id: str | None = None
    ) -> list[str]:
        """The paths a pathname pattern matches, as the shell expands it.

        The shell's own resolver matches it, so a pattern crosses
        mounts, sees namespace links, and honors the session's hides
        and ``dotglob``. A ``**`` segment matches any number of
        directories (bash's ``globstar``); a pattern that matches
        nothing gives no paths (``nullglob``), and a path with no glob
        character gives itself when it exists. A relative pattern is
        read from the session's working directory.

        Args:
            pattern (str): the pattern, such as ``/src/**/*.py``.
            session_id (str | None): session to run as outside a line.

        Returns:
            list[str]: the matching paths, sorted.
        """
        return await self._bind_session(
            session_id, partial(self._glob, pattern)
        )

    async def _glob(self, pattern: str) -> list[str]:
        session = get_current_session_for(self._session_mgr)
        cwd = session.cwd if session is not None else "/"
        spec = classify_bare_path(pattern, self._registry, cwd)
        if not isinstance(spec, PathSpec):
            return []
        if spec.pattern is None:
            return (
                [spec.virtual] if await self.vfs.exists(spec.virtual) else []
            )
        matches = await resolve_globs(
            [spec],
            self._registry,
            links=self._namespace,
            options=GlobOptions(nullglob=True, globstar=True),
        )
        return [m.virtual for m in matches if isinstance(m, PathSpec)]

    # ── execution ────────────────────────────────────────────────────────────

    def _execute_env(self) -> ExecuteEnv:
        """The parts a line runs against (``execute_line``)."""
        return ExecuteEnv(
            meta=self._meta,
            drift=self._drift,
            namespace=self._namespace,
            sessions=self._session_mgr,
            registry=self._registry,
            dispatcher=self._dispatcher,
            observer=self.observer,
            records=self._files.records,
            job_table=self.job_table,
            agent_id=self._default_agent_id,
            runtimes=self._runtimes,
            router=self._router,
            processes=self.processes,
            dispatch=self.dispatch,
            has_managed_env=lambda: self._has_managed_env,
            secret_sources=self._secret_sources,
            execute=self.shell,
        )

    async def apply_io(
        self,
        io: IOResult,
        records: list[OpRecord] | None = None,
        cache_facts: Callable[[str], CacheFacts] | None = None,
    ) -> None:
        await self._dispatcher.apply_io(
            io, records=records, cache_facts=cache_facts
        )

    async def _serialize_line(
        self,
        session_id: str | None,
        run: Callable[[], Awaitable[IOResult]],
    ) -> IOResult:
        """Run one line of a session at a time, as one bash process does.

        Two top-level lines on one session share its env, cwd and ``$?``,
        so letting them interleave hands one line the loop variable the
        other just set: two ``for f`` loops both exit 0 and both print
        the other's values. A nested line (``eval``, ``source``, ``$()``,
        ``xargs``, a host callback fired mid-line) is the same shell
        continuing and runs inline: it already holds the session, and
        waiting on itself would deadlock. The ambient binding decides,
        by the same rule ``execute_line`` uses to pick the session a
        line runs as, so the lock key and the executed session never
        disagree; a background job's fork keeps its parent's id and
        continues inline too.

        Args:
            session_id (str | None): the session the caller named, or
                None for the default.
            run (Callable[[], Awaitable[IOResult]]):
                the line, started only once the session is held.
        """
        ambient = get_current_session_for(self._session_mgr)
        if ambient is not None and session_id in (None, ambient.session_id):
            return await run()
        # Hydrate first: a workspace on a shared store adopts the
        # persisted default id there, and a key taken before that names
        # a session no later line would wait on.
        await self.ensure_sessions_loaded()
        if session_id is None:
            session_id = self._session_mgr.default_id
        async with self._session_mgr.line_lock_for(session_id):
            # A line queued behind a running one wakes after close may
            # have started; it runs nothing, like a line that arrived
            # after.
            if self._shutting_down:
                raise RuntimeError("Workspace is closed")
            return await run()

    @overload
    async def shell(
        self,
        command: str,
        session_id: str | None = None,
        stdin: ByteSource | None = None,
        agent_id: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cancel: asyncio.Event | None = None,
        record: bool = True,
        runtime: str | None = None,
        routing_decision: RouteDecision[Runtime] | None = None,
        handed: HandOff | None = None,
        sink: JobConsole | None = None,
        call_stack: CallStack | None = None,
        execution_scope: ExecutionScope | None = None,
        job_table: JobTable | None = None,
        *,
        stream: Literal[True],
    ) -> ShellExecution: ...

    @overload
    async def shell(
        self,
        command: str,
        session_id: str | None = None,
        stdin: ByteSource | None = None,
        agent_id: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cancel: asyncio.Event | None = None,
        record: bool = True,
        runtime: str | None = None,
        routing_decision: RouteDecision[Runtime] | None = None,
        handed: HandOff | None = None,
        sink: JobConsole | None = None,
        call_stack: CallStack | None = None,
        execution_scope: ExecutionScope | None = None,
        job_table: JobTable | None = None,
        *,
        stream: Literal[False] = False,
    ) -> IOResult: ...

    @overload
    async def shell(
        self,
        command: str,
        session_id: str | None = None,
        stdin: ByteSource | None = None,
        agent_id: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cancel: asyncio.Event | None = None,
        record: bool = True,
        runtime: str | None = None,
        routing_decision: RouteDecision[Runtime] | None = None,
        handed: HandOff | None = None,
        sink: JobConsole | None = None,
        call_stack: CallStack | None = None,
        execution_scope: ExecutionScope | None = None,
        job_table: JobTable | None = None,
        *,
        stream: bool,
    ) -> IOResult | ShellExecution: ...

    async def shell(
        self,
        command: str,
        session_id: str | None = None,
        stdin: ByteSource | None = None,
        agent_id: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cancel: asyncio.Event | None = None,
        record: bool = True,
        runtime: str | None = None,
        routing_decision: RouteDecision[Runtime] | None = None,
        handed: HandOff | None = None,
        sink: JobConsole | None = None,
        call_stack: CallStack | None = None,
        execution_scope: ExecutionScope | None = None,
        job_table: JobTable | None = None,
        *,
        stream: bool = False,
    ) -> IOResult | ShellExecution:
        """Execute a shell command, or return its running execution when streamed.

        Args:
            stream (bool): return a ShellExecution with bounded ordered events.
                Consume events before awaiting final status, and use async with
                when abandoning output early. False collects the same events.
            command: The shell command string to execute.
            session_id: Session whose persistent state hosts the command.
            stdin: Optional stdin payload (bytes or async byte iterator).
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
                mid-flight. The whole line runs as one task, so setting
                the event cancels it at whatever await it is in; the task
                is joined before MirageAbortError is raised, and `$?` is
                restored to what the line found. The event is the
                caller's alone: the line never sets it, so a command
                timeout is exit 124, not an abort.
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
            handed: Internal. The hand-off the line runs on, made by the
                executor's nested evals under the outer line's so an
                inner line spends the grants the outer line's pass
                claimed for it.
            sink: Internal. The console the executor's nested lines
                (``eval``, ``source``, a nested shell) write to as each
                statement finishes, stdout and stderr in the order they
                were produced. Every path answers there, a refusal or a
                syntax error included, so the result carries the exit
                status and no output.
            call_stack: Internal. The frames of the caller a nested line
                runs in place of (``eval``): its commands see the
                caller's positional parameters and locals, and an
                ``exit``, ``return``, ``break`` or ``continue`` in it
                unwinds into the caller instead of ending the line.
            execution_scope: Internal. Scheduling and admission shared by
                nested foreground evaluations. Background jobs start a
                separate scope.
            job_table: Internal. The jobs of a child shell (``$( )``,
                ``bash -c``) that the line starts its own in, where its
                caller's ``jobs`` and ``wait`` never see them; None for
                the session's.
        """
        if stream and sink is not None:
            raise ValueError("stream and sink are mutually exclusive")
        if not stream and (
            sink is not None
            or handed is not None
            or execution_scope is not None
            or call_stack is not None
            or job_table is not None
            or get_current_session_for(self._session_mgr) is not None
        ):
            return await self._shell(
                command,
                session_id,
                stdin,
                agent_id,
                cwd,
                env,
                cancel,
                record,
                runtime,
                routing_decision,
                handed,
                sink,
                call_stack,
                execution_scope,
                job_table,
            )
        if self._shutting_down:
            raise RuntimeError("Workspace is closed")

        async def run(
            output: JobConsole, stop: asyncio.Event, scope: ExecutionScope
        ) -> IOResult:
            return await self._shell(
                command,
                session_id,
                stdin,
                agent_id,
                cwd,
                env,
                stop,
                record,
                runtime,
                routing_decision,
                handed,
                output,
                call_stack,
                scope,
                job_table,
            )

        execution = ShellExecution(
            run,
            execution_scope or ExecutionScope(),
            cancel,
            buffer_bytes=self.io.buffer_bytes,
        )
        if stream:
            self._shell_executions.add(execution)
            execution.on_settled(
                lambda: self._shell_executions.discard(execution)
            )
            try:
                await asyncio.sleep(0)
            except asyncio.CancelledError:
                await execution.aclose()
                raise
            return execution
        return await execution.collect()

    async def _shell(
        self,
        command: str,
        session_id: str | None = None,
        stdin: ByteSource | None = None,
        agent_id: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cancel: asyncio.Event | None = None,
        record: bool = True,
        runtime: str | None = None,
        routing_decision: RouteDecision[Runtime] | None = None,
        handed: HandOff | None = None,
        sink: JobConsole | None = None,
        call_stack: CallStack | None = None,
        execution_scope: ExecutionScope | None = None,
        job_table: JobTable | None = None,
    ) -> IOResult:
        """Run the internal shell invocation with its existing cancellation scope."""
        # The one cancellation seam: the whole line is one task, so a
        # cancel set while a store is still loading, a secret is still
        # fetching, the tree is still running or the flush is still
        # writing lands on that await, and the line is joined before the
        # abort is raised. The event is the caller's and the line never
        # sets it. A top-level line (a nested one is handed its caller's
        # grants) also answers the workspace's own stop, set by
        # ``cancel``.
        frame = LineFrame()
        stop: asyncio.Event | None = None
        ended = asyncio.Event()
        token = None
        if handed is None:
            stop = asyncio.Event()
            self._lines[stop] = (session_id, ended)
            token = LINE_STOP.set(stop)
        try:
            if stop is not None:
                await self._admit_line(stop, cancel)
            result = await run_cancellable(
                self._serialize_line(
                    session_id,
                    partial(
                        execute_line,
                        self._execute_env(),
                        command,
                        session_id,
                        stdin,
                        agent_id,
                        cwd,
                        env,
                        cancel,
                        record,
                        runtime,
                        routing_decision,
                        handed,
                        frame,
                        sink=sink,
                        call_stack=call_stack,
                        execution_scope=execution_scope,
                        job_table=job_table,
                    ),
                ),
                cancel,
                stop,
            )
        except (MirageAbortError, asyncio.CancelledError):
            # An abandoned invocation is the caller's outcome, not the
            # shell's, whether it arrived on the event or as a cancel
            # from outside: `$?` goes back to what the line found,
            # whichever await it landed on. Here, after the last of them,
            # so no path can forget it.
            if frame.session is not None and frame.status_before is not None:
                restore_status(
                    frame.session, frame.status_before, frame.writer
                )
            raise
        finally:
            if stop is not None and token is not None:
                del self._lines[stop]
                self._admitted.discard(stop)
                ended.set()
                LINE_STOP.reset(token)
        if sink is not None and isinstance(result, IOResult):
            for channel, data in (
                (Channel.STDOUT, await result.materialize_stdout()),
                (Channel.STDERR, await result.materialize_stderr()),
            ):
                if data:
                    await sink.emit(channel, data)
            result.stdout = result.stderr = None
        return result


class Session:
    """One session's entry points, bound together.

    ``shell`` runs a line as the session, ``vfs`` is the file API run
    as it, ``tools`` the agent tools over both and ``explain`` the same
    entry points as a dry run, so a host holds one
    object per agent and every entry point answers under the same profile:
    hides, mount modes, grants and standing decisions. Nothing is
    stored here; the session record stays with the session manager and
    ``state`` reads it. Obtained from ``Workspace.session``, which
    creates the session or adopts it. A None id is the workspace's
    default session as it is when each call runs, the way ``ws.vfs``
    and ``ws.shell`` follow it when a snapshot load or an attach
    re-keys it.
    """

    def __init__(self, ws: Workspace, session_id: str | None) -> None:
        self._ws = ws
        self._id = session_id

    @property
    def session_id(self) -> str:
        return (
            self._id if self._id is not None else self._ws.default_session_id
        )

    @property
    def state(self) -> SessionState:
        """The session record: cwd, env, modes, hides, decisions."""
        return self._ws.get_session(self.session_id)

    @property
    def decisions(self) -> Decisions:
        """The workspace's approval ledger, which this session's asked
        commands and ops are recorded in."""
        return self._ws.decisions

    def mounts(self) -> list[MountEntry]:
        """The workspace's mounts, which the session's profile narrows."""
        return self._ws.mounts()

    @property
    def vfs(self) -> Files:
        """The file API run as this session."""
        if self._id is None:
            return self._ws.vfs
        return self._ws.vfs._for_session(self._id)

    @property
    def explain(self) -> Explainer:
        """This session's calls explained instead of run, under the same
        names: ``explain.shell(line)``, ``explain.vfs.<call>(...)``."""
        return Explainer(self._ws.explain, self._id, self.vfs)

    @property
    def tools(self) -> MirageToolOperations:
        """The agent tools run as this session: one table per session,
        shared by every caller in the process."""
        return self._ws._session_tools(self._id)

    async def _loaded(self) -> None:
        """Hydrate the workspace's sessions, so a stored one is known."""
        await self._ws.ensure_sessions_loaded()

    async def _reads(self) -> FileVersionTracker:
        """The read history the session's agent tools share."""
        return await self._ws._session_reads(self._id)

    @overload
    async def shell(
        self,
        command: str,
        stdin: ByteSource | None = None,
        agent_id: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cancel: asyncio.Event | None = None,
        record: bool = True,
        runtime: str | None = None,
        *,
        stream: Literal[True],
    ) -> ShellExecution: ...

    @overload
    async def shell(
        self,
        command: str,
        stdin: ByteSource | None = None,
        agent_id: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cancel: asyncio.Event | None = None,
        record: bool = True,
        runtime: str | None = None,
        *,
        stream: Literal[False] = False,
    ) -> IOResult: ...

    @overload
    async def shell(
        self,
        command: str,
        stdin: ByteSource | None = None,
        agent_id: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cancel: asyncio.Event | None = None,
        record: bool = True,
        runtime: str | None = None,
        *,
        stream: bool,
    ) -> IOResult | ShellExecution: ...

    async def shell(
        self,
        command: str,
        stdin: ByteSource | None = None,
        agent_id: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cancel: asyncio.Event | None = None,
        record: bool = True,
        runtime: str | None = None,
        *,
        stream: bool = False,
    ) -> IOResult | ShellExecution:
        """Run a shell line as this session; ``Workspace.shell`` with
        the session fixed.

        Args:
            command (str): the shell line.
            stdin (ByteSource | None): stdin payload.
            agent_id (str | None): agent identifier for observability.
            cwd (str | None): per-call working directory, run in an
                ephemeral clone of the session.
            env (dict[str, str] | None): per-call env overrides, run in
                an ephemeral clone of the session.
            cancel (asyncio.Event | None): abort signal.
            record (bool): whether the line enters history.
            runtime (str | None): the runtime to route the line to.
            stream (bool): return bounded live events and a final status handle.
        """
        return await self._ws.shell(
            command,
            session_id=self._id,
            stdin=stdin,
            agent_id=agent_id,
            cwd=cwd,
            env=env,
            cancel=cancel,
            record=record,
            runtime=runtime,
            stream=stream,
        )

    async def glob(self, pattern: str) -> list[str]:
        """The paths a pattern matches as this session;
        ``Workspace.glob`` with the session fixed.

        Args:
            pattern (str): the pattern, such as ``/src/**/*.py``.
        """
        return await self._ws.glob(pattern, session_id=self._id)

    async def vfs_md(self, path: str | PathSpec | None = None) -> str:
        """Render this session's VFS Markdown, optionally at a virtual path.

        Args:
            path (str | PathSpec | None): destination inside this workspace.
        """
        return await self._ws.vfs_md(path, session_id=self._id)

    async def skill_md(self, path: str | PathSpec | None = None) -> str:
        """Render this session's CLI skill, optionally at a virtual path.

        Args:
            path (str | PathSpec | None): destination inside this workspace.
        """
        return await self._ws.skill_md(path, session_id=self._id)
