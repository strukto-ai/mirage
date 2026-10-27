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

import importlib
import json
import logging
import tempfile
from contextlib import AbstractAsyncContextManager
from pathlib import Path, PurePosixPath
from typing import Any, Protocol, cast, get_args

from pydantic import BaseModel

from mirage.cache.file.entry import CacheEntry
from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index.config import IndexConfig
from mirage.commands.cli.types import CLI
from mirage.commands.spec.types import CommandSpec
from mirage.concurrency.limiter import run_blocking
from mirage.core.disk.utils import open_regular
from mirage.io.config import IOConfig
from mirage.observe.log_entry import EVENT_CLEAR, EVENT_COMMAND, EVENT_DELETE
from mirage.observe.observer import Observer
from mirage.policy.builtin.output_cap import command_limits_to_json
from mirage.policy.policies import Policies
from mirage.policy.profile import (
    SessionProfile,
    profile_from_dict,
    profile_to_dict,
)
from mirage.runtime.types import Language, ScriptSource
from mirage.shell.console import (
    Channel,
    ConsoleChunk,
    JobConsole,
    RAMConsoleStore,
    exit_outcome,
    killed_outcome,
)
from mirage.shell.constants import BIN_PREFIX
from mirage.shell.job_table import Job, JobStatus, JobTable
from mirage.shell.variable import ShellVar
from mirage.types import (
    JsonValue,
    Limit,
    MountMode,
    ReadSpec,
    VFSName,
    WritePolicy,
)
from mirage.utils.loader import SCRIPT_MODULE_NAME
from mirage.utils.path import norm_dir
from mirage.version import __version__
from mirage.vfs.base import BaseVFS
from mirage.vfs.history import HISTORY_PREFIX
from mirage.vfs.registry import (
    REGISTRY,
    VFSEntry,
    resolve_class,
    resolve_entry,
    unknown_kwargs,
)
from mirage.vfs.secrets import (
    has_redacted_secret,
    redacted_config_dump,
    revealed_config_dump,
)
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.documentation.documents import Documents
from mirage.workspace.files import WorkspaceFiles
from mirage.workspace.mount.errors import MountOverrideError, WritePolicyError
from mirage.workspace.mount.namespace import Namespace, NodeMeta
from mirage.workspace.mount.read_policy import resolve_read_spec
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.mount.spec import Mount
from mirage.workspace.mount.write_policy import coerce_write_policy
from mirage.workspace.session.manager import SessionManager
from mirage.workspace.session.resolve import (
    narrow,
    narrowing_of,
    stricter_modes,
)
from mirage.workspace.session.session import (
    SessionState,
    vars_from_fields,
    vars_to_fields,
)
from mirage.workspace.session.shell_dirs import set_cwd
from mirage.workspace.session.state import gate_restored_vars
from mirage.workspace.snapshot.config import (
    MountArgs,
    index_config_dump,
    restore_index_config,
)
from mirage.workspace.snapshot.drift import (
    capture_fingerprints,
    live_only_mount_prefixes,
)
from mirage.workspace.snapshot.keys import (
    CacheKey,
    CLIKey,
    JobKey,
    MountKey,
    ScriptKey,
    StateKey,
    VFSStateKey,
)
from mirage.workspace.snapshot.utils import FORMAT_VERSION

logger = logging.getLogger(__name__)


class WorkspaceLike(Protocol):
    """What a snapshot reads from a workspace and restores into it
    (``Workspace``)."""

    observer: Observer
    job_table: JobTable
    _session_mgr: SessionManager
    _implicit_root: bool
    _write_default: WritePolicy
    _documents: Documents
    _profiles: dict[str, SessionProfile]
    _default_profile_name: str | None

    @property
    def registry(self) -> MountRegistry: ...

    @property
    def cache(self) -> FileCacheMixin: ...

    @property
    def vfs(self) -> WorkspaceFiles: ...

    @property
    def namespace(self) -> Namespace: ...

    @property
    def policies(self) -> Policies: ...

    def _forget_reads(self) -> None: ...

    async def _adopt_default_session(self, session_id: str) -> None: ...

    def _quiesced(self) -> AbstractAsyncContextManager[None]: ...


# A per-name override for restoring installed CLIs: a plain mapping is a
# fresh config (the spec resolves from the snapshot's registry key); a
# (spec, config) tuple carries a live spec too, which is how copy()
# shares directly installed programs.
CLIOverrides = dict[
    str, dict[str, Any] | tuple[str | CLI, dict[str, Any] | None]
]

# What a snapshot restores into the env plane, once the gate has passed
# it: the parsed session tables and the env template (None when the
# snapshot carries none).
RestoredEnv = tuple[list[SessionState], dict[str, ShellVar] | None]


def cli_config_dump(
    config: BaseModel | dict[str, JsonValue] | None, reveal: bool = False
) -> dict[str, Any] | None:
    """Serialize an installation's config for a snapshot.

    A model-backed config redacts (or reveals, for a same-process copy)
    its schema-declared secrets. A script install's config is an opaque
    mapping instead: with no ``config_model`` nothing declares which
    keys are secret, so it is captured verbatim rather than guessed at,
    and a script CLI that needs a credential reads it from a managed
    env var. The YAML loader refuses a secrets pointer in a script's
    config for exactly this reason (``CLIBlock``): resolved, the value
    would sit in this verbatim capture.

    Args:
        config (BaseModel | dict[str, JsonValue] | None): the validated
            install config.
        reveal (bool): reveal secrets instead of redacting them, which
            only a same-process copy does.
    """
    if config is None:
        return None
    if isinstance(config, BaseModel):
        return (
            revealed_config_dump(config)
            if reveal
            else redacted_config_dump(config)
        )
    return dict(config)


def cli_snapshot(name: str, install: CLIInstall) -> dict[str, Any]:
    """One installed CLI as snapshot state.

    A registry-resolvable program is persisted by name, because the
    spec is code that the loading process imports. A script install has
    no name to resolve (the spec is synthesized from a yaml ``script:``
    at load), so its embedded program rides along and ``load`` rebuilds
    the spec from it; without this the head word would resolve against
    the registry and fail.

    Args:
        name (str): installed head word.
        install: the CLIInstall being captured.
    """
    entry: dict[str, Any] = {
        CLIKey.NAME: name,
        CLIKey.SPEC: install.cli.spec.name,
        CLIKey.CONFIG: cli_config_dump(install.config),
    }
    script = install.cli.script
    if script is not None:
        entry[CLIKey.SCRIPT] = {
            ScriptKey.SOURCE: script.source,
            ScriptKey.LANGUAGE: script.language,
            ScriptKey.MODULE: script.module,
        }
        entry[CLIKey.RUNTIME] = install.cli.runtime
    return entry


def cli_spec_from_entry(entry: dict[str, Any]) -> str | CLI:
    """The spec a snapshot entry restores: a registry key or a program.

    Args:
        entry (dict[str, Any]): one captured ``clis`` entry.

    Raises:
        ValueError: the captured script names a language no runtime can
            speak. The value comes from a file, so it is checked here
            rather than carried to the selector, which would report the
            world's runtimes for a language that never existed.
    """
    script = entry.get(CLIKey.SCRIPT)
    if not isinstance(script, dict):
        return str(entry[CLIKey.SPEC])
    name = str(entry[CLIKey.SPEC])
    language = script.get(ScriptKey.LANGUAGE)
    if language not in get_args(Language):
        raise ValueError(
            f"snapshot cli {name!r}: unknown script language {language!r}"
        )
    return CLI(
        spec=CommandSpec(name=name),
        script=ScriptSource(
            str(script[ScriptKey.SOURCE]),
            language=cast(Language, language),
            module=bool(script.get(ScriptKey.MODULE)),
        ),
        runtime=entry.get(CLIKey.RUNTIME),
    )


async def to_state_dict(ws: WorkspaceLike) -> dict[str, Any]:
    auto_prefixes = {
        "/dev/",
        norm_dir(HISTORY_PREFIX),
        norm_dir(BIN_PREFIX),
    }

    mounted = ws.registry.mounts()
    for mount in mounted:
        await mount.ensure_ready()
    mounts_state = []
    first_prefix: dict[int, str] = {}
    for idx, m in enumerate(
        mt
        for mt in mounted
        if mt.prefix not in auto_prefixes and mt.vfs.name != "document"
    ):
        async with m.use():
            # Disk walks the host tree and redis answers over a
            # blocking client, so neither runs on the loop.
            vfs_state = (
                await run_blocking(m.vfs.get_state)
                if m.vfs.name in (VFSName.DISK, VFSName.REDIS)
                else m.vfs.get_state()
            )
        row: dict[str, Any] = {
            MountKey.INDEX: idx,
            MountKey.PREFIX: m.prefix,
            MountKey.MODE: m.mode.value,
            MountKey.READ: m.read.policy.value,
            MountKey.TTL: m.read.ttl,
            MountKey.WRITE: m.write.value,
            MountKey.VFS_CLASS: f"{type(m.vfs).__module__}.{type(m.vfs).__name__}",
            MountKey.VFS_REF: m.vfs_ref,
            MountKey.INDEX_CONFIG: index_config_dump(m.index_config),
            MountKey.VFS_STATE: vfs_state,
        }
        # The scratch root nobody mounted keeps its files across the
        # round trip, and a load marks it the scratch root again.
        if ws._implicit_root and m.prefix == "/":
            row[MountKey.ANCHOR] = True
        if m.command_limits:
            row[MountKey.COMMAND_LIMITS] = command_limits_to_json(
                m.command_limits
            )
        # Each later prefix on one VFS names the first, so a load builds it once.
        leader = first_prefix.setdefault(id(m.vfs), m.prefix)
        if leader != m.prefix:
            row[MountKey.SAME_VFS_AS] = leader
        mounts_state.append(row)

    # Only a RAM cache holds entries the snapshot can carry; a Redis
    # cache lives outside the workspace and is skipped on both sides
    # (see `_restore_cache`), as TypeScript's `toStateDict` does.
    cache = ws.cache
    cache_entries = (
        [
            {
                CacheKey.KEY: k,
                CacheKey.DATA: cache._store.files.get(k, b""),
                CacheKey.FINGERPRINT: e.fingerprint,
                CacheKey.TTL: e.ttl,
                CacheKey.CACHED_AT: e.cached_at,
                CacheKey.SIZE: e.size,
            }
            for k, e in cache._entries.items()
            if e.has_bytes
        ]
        if isinstance(cache, RAMFileCacheStore)
        else []
    )

    history_events = [
        e
        for e in await ws.observer.events()
        if e.get("type") in (EVENT_COMMAND, EVENT_CLEAR, EVENT_DELETE)
    ]

    clis_state = [
        cli_snapshot(name, install)
        for name, install in ws.registry.clis.items().items()
    ]

    # The lists live in the job store, where other workspaces on it add
    # jobs this one has not read yet. A killed job is finished only once
    # its console ended: its runner may still leave output and a status.
    for s in ws._session_mgr.list():
        await ws.job_table.sync(s.session_id)
    finished_jobs = [
        await _job_to_dict(j)
        for j in ws.job_table.all_jobs()
        if j.status != JobStatus.RUNNING
        and (j.process is None or j.console.finished)
    ]

    if mounted != ws.registry.mounts() or any(m.retiring for m in mounted):
        raise RuntimeError("mounts changed during snapshot")
    fingerprints = capture_fingerprints(ws.vfs.records, ws.registry)
    live_only_mounts = live_only_mount_prefixes(ws.registry, ws._implicit_root)

    return {
        StateKey.VERSION: FORMAT_VERSION,
        StateKey.IO: ws.registry.io.model_dump(),
        StateKey.WRITE: ws._write_default.value,
        StateKey.MIRAGE_VERSION: __version__,
        StateKey.MOUNTS: mounts_state,
        StateKey.SESSIONS: [s.to_dict() for s in ws._session_mgr.list()],
        StateKey.ENV: vars_to_fields(ws._session_mgr.seed_vars),
        StateKey.DEFAULT_SESSION_ID: ws._session_mgr.default_id,
        StateKey.CACHE: {
            CacheKey.LIMIT: cache.cache_limit,
            CacheKey.MAX_DRAIN_BYTES: cache.max_drain_bytes,
            CacheKey.ENTRIES: cache_entries,
        },
        StateKey.HISTORY: history_events,
        StateKey.CLIS: clis_state,
        StateKey.JOBS: finished_jobs,
        StateKey.FINGERPRINTS: fingerprints,
        StateKey.LIVE_ONLY_MOUNTS: live_only_mounts,
        StateKey.NODES: {
            path: meta.to_fields() for path, meta in ws.namespace.nodes.items()
        },
        # The profile table and the limits are what every session here
        # runs under: a load built without them ran each one unconfined.
        StateKey.PROFILES: {
            name: profile_to_dict(profile)
            for name, profile in ws._profiles.items()
        },
        StateKey.PROFILE: ws._default_profile_name,
        StateKey.COMMAND_LIMITS: command_limits_to_json(
            ws.registry.command_limits
        ),
    }


def check_format_version(state: dict[str, Any]) -> None:
    """Refuse a snapshot this loader cannot read.

    An absent version is v3 or older, not "current". It used to be
    harmless because every key the loader read had a default; v4 makes
    the read policy required, so an unversioned dict would land on a
    bare KeyError instead of this message.

    Both entry points run it. ``build_mount_args`` builds a workspace from the
    state; ``apply_state_dict`` restores into one that already exists,
    and is what ``version checkout``, ``version restore`` and the agent
    sandbox's hydrate call. Checking in one entry point only meant the same
    bytes were refused through ``Workspace.load`` and half-restored
    through a checkout.

    Args:
        state (dict[str, Any]): the snapshot state.

    Raises:
        ValueError: the snapshot is in another format than this
            loader's, older or newer.
    """
    saved_version = state.get(StateKey.VERSION)
    # A newer snapshot may carry keys this loader would drop.
    if saved_version != FORMAT_VERSION:
        shown = "unversioned" if saved_version is None else f"v{saved_version}"
        raise ValueError(
            f"snapshot format {shown} not supported "
            f"(loader expects v{FORMAT_VERSION}); "
            "regenerate via `mirage workspace snapshot`"
        )


def vfs_groups(state: dict[str, Any]) -> dict[str, str]:
    """Each saved prefix mapped to the first prefix of the VFS it shares.

    A row with no ``same_vfs_as`` leads its own group; a snapshot written
    before the key existed is all leaders, and loads as it always did.

    Args:
        state (dict[str, Any]): the snapshot state.

    Raises:
        ValueError: a row names a prefix that is not an earlier row
            leading its own group.
    """
    groups: dict[str, str] = {}
    for m in state[StateKey.MOUNTS]:
        prefix = norm_dir(m[MountKey.PREFIX])
        if MountKey.SAME_VFS_AS not in m:
            groups[prefix] = prefix
            continue
        named = m[MountKey.SAME_VFS_AS]
        leader = norm_dir(named) if isinstance(named, str) else None
        if leader is None or leader == prefix or groups.get(leader) != leader:
            shown = (
                named
                if isinstance(named, str)
                else json.dumps(
                    named, separators=(",", ":"), ensure_ascii=False
                )
            )
            raise ValueError(
                f"Workspace.load: mount '{m[MountKey.PREFIX]}' shares the "
                f"VFS of '{shown}', which no earlier mount leads; "
                "regenerate the snapshot"
            )
        groups[prefix] = leader
    return groups


def vfs_leaders(state: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Each saved prefix mapped to the first saved row of the VFS it shares.

    Args:
        state (dict[str, Any]): the snapshot state.

    Raises:
        ValueError: a row names no earlier mount as the VFS it shares.
    """
    rows = {norm_dir(m[MountKey.PREFIX]): m for m in state[StateKey.MOUNTS]}
    return {prefix: rows[lead] for prefix, lead in vfs_groups(state).items()}


def build_mount_args(
    state: dict[str, Any],
    mounts: dict[str, Any] | None = None,
    clis: CLIOverrides | None = None,
) -> MountArgs:
    """Translate a state dict into Workspace constructor inputs.

    Validates that every mount with redacted secrets has a VFS
    override, and every CLI installed with a redacted config has a
    fresh config override. A VFS saved at several prefixes is built
    once and mounted at all of them; an override for any of those
    prefixes supplies it at every prefix with no override of its own.
    Does NOT construct a Workspace — that's the caller's job.

    Args:
        state (dict[str, Any]): the snapshot state.
        mounts (dict[str, Any] | None): ``{prefix: VFS | Mount}``
            overrides.
        clis (CLIOverrides | None): per-name CLI overrides.

    Raises:
        MountOverrideError: overrides hand one saved VFS different VFSs
            and leave a prefix of it without one.
        ValueError: if any redacted mount or CLI lacks an override, a
            row names no earlier mount as the VFS it shares, or the
            snapshot is from an unsupported format version.
    """
    check_format_version(state)

    overrides = {norm_dir(k): v for k, v in (mounts or {}).items()}
    groups = vfs_groups(state)
    rows = {norm_dir(m[MountKey.PREFIX]): m for m in state[StateKey.MOUNTS]}
    # An override supplies its group's VFS and label, else the first row does.
    placed_at = {
        prefix: _placed_vfs(overrides[prefix], m)
        for prefix, m in rows.items()
        if prefix in overrides
    }
    supplied: dict[str, list[tuple[BaseVFS, str | None]]] = {}
    for prefix, placed in placed_at.items():
        held = supplied.setdefault(groups[prefix], [])
        if all(vfs is not placed[0] for vfs, _ in held):
            held.append(placed)
    split = {group for group, held in supplied.items() if len(held) > 1}
    ambiguous = [
        m[MountKey.PREFIX]
        for prefix, m in rows.items()
        if prefix not in overrides and groups[prefix] in split
    ]
    if ambiguous:
        given = [
            m[MountKey.PREFIX]
            for prefix, m in rows.items()
            if prefix in overrides and groups[prefix] in split
        ]
        raise MountOverrideError(
            f"Workspace.load: mounts= gives different VFSs for {given}, "
            f"which were saved as one VFS; override {ambiguous} too, or "
            "give them all one VFS"
        )

    # Named once per saved VFS: an override at any of its prefixes serves all.
    missing = [
        m[MountKey.PREFIX]
        for prefix, m in rows.items()
        if groups[prefix] == prefix
        and prefix not in supplied
        and requires_vfs_override(m)
    ]
    if missing:
        raise ValueError(
            "Workspace.load: mounts= must include overrides for: "
            f"{missing}. A listed mount was saved with redacted "
            "credentials, asked to be handed back live (needs_override), "
            "or names a class this process cannot import; register the "
            "class (register_vfs) or pass a live instance."
        )

    cli_overrides = clis or {}
    cli_entries = state.get(StateKey.CLIS) or []
    missing_clis = [
        e[CLIKey.NAME]
        for e in cli_entries
        if has_redacted_secret(e[CLIKey.CONFIG])
        and e[CLIKey.NAME] not in cli_overrides
    ]
    if missing_clis:
        raise ValueError(
            "Workspace.load: clis= must include fresh configs for: "
            f"{missing_clis}. These CLIs were saved with redacted "
            "config secrets."
        )

    mount_args: dict[str, Mount] = {}
    built: dict[str, tuple[BaseVFS, str | None]] = {}
    # A VFS runs one index, its first prefix's (the registry aliases the
    # rest): an override's index if one came with it, else the saved one.
    given_index: dict[int, IndexConfig] = {}
    for prefix in rows:
        override = overrides.get(prefix)
        if isinstance(override, Mount) and override.index is not None:
            given_index.setdefault(id(override.vfs), override.index)
    indexed: set[int] = set()
    anchored = False
    for prefix, m in rows.items():
        group = groups[prefix]
        override = overrides.get(prefix)
        # The saved scratch root is restored like any prefix, then marked.
        root = prefix == "/" and m.get(MountKey.ANCHOR) is True
        anchored = anchored or root
        # A prefix carries the label of what supplied its VFS, so a
        # second round trip rebuilds through the same entry point.
        if override is not None:
            prov, ref = placed_at[prefix]
        elif group in supplied:
            prov, ref = supplied[group][0]
        else:
            if group not in built:
                leader = rows[group]
                built[group] = (
                    _construct_vfs(leader),
                    leader.get(MountKey.VFS_REF),
                )
            prov, ref = built[group]
        # Named, never `.get(default)` and never a bare subscript: a
        # dict labelled v4 with the key missing would silently install a
        # default on a mount that was saved otherwise, which is the
        # whole failure this version bump exists to prevent -- and the
        # subscript said so as `KeyError: 'read'`, which names neither
        # the mount nor the fix. `mode`, subscripted below, is the same
        # shape of required key. TypeScript refuses it here too.
        if MountKey.READ not in m or MountKey.TTL not in m:
            raise ValueError(
                f"Workspace.load: mount {m[MountKey.PREFIX]!r} is missing "
                "its read policy; regenerate the snapshot"
            )
        # Through the coercer, so a junk policy or a null/non-positive
        # bound is refused here rather than restoring a mount whose
        # bound can never expire.
        read = resolve_read_spec(m[MountKey.READ], m[MountKey.TTL])
        # The saved policy belongs to the backend that was saved. A mount
        # handed back through `mounts=` -- which a redacted-credential
        # mount *must* be -- may be a different backend entirely, and
        # carrying `fresh` onto one that cannot revalidate would refuse a
        # restore that used to succeed. The override keeps its own
        # policy, else the default; TypeScript applies the same rule to
        # its stand-in. A prefix sharing an overridden VFS sits on that
        # backend too.
        if group in supplied:
            read = (
                override.read
                if isinstance(override, Mount) and override.read is not None
                else ReadSpec()
            )
        # The saved policy survives an override, as `mode` does.
        saved_write = m.get(MountKey.WRITE)
        if saved_write is None or saved_write == "":
            raise WritePolicyError(
                f"Workspace.load: mount {m[MountKey.PREFIX]!r} is missing "
                "its write policy; regenerate the snapshot"
            )
        write = coerce_write_policy(str(saved_write))
        asked = (
            coerce_write_policy(override.write)
            if isinstance(override, Mount) and override.write is not None
            else None
        )
        if asked is not None and asked is not write:
            raise WritePolicyError(
                f"Workspace.load: mount {m[MountKey.PREFIX]!r} was saved "
                f"write: {write.value}; the override asks write: "
                f"{asked.value}"
            )
        # The mount's own limits, its "@all" walk_limit among them, come back
        # as saved unless the override names its own.
        limits = (
            override.command_limits
            if isinstance(override, Mount) and override.command_limits
            else {
                name: Limit.model_validate(limit)
                for name, limit in m.get(MountKey.COMMAND_LIMITS, {}).items()
            }
        )
        index = (
            None
            if id(prov) in indexed
            else restore_index_config(
                m.get(MountKey.INDEX_CONFIG), given_index.get(id(prov)), prefix
            )
        )
        indexed.add(id(prov))
        mount_args[m[MountKey.PREFIX]] = Mount(
            vfs=prov,
            mode=MountMode(m[MountKey.MODE]),
            read=read,
            write=write,
            command_limits=limits,
            vfs_ref=ref,
            index=index,
        )

    cli_args: dict[str, tuple[str | CLI, dict[str, Any] | None]] = {}
    for e in cli_entries:
        override = cli_overrides.get(e[CLIKey.NAME])
        if isinstance(override, tuple):
            # copy() shares the live spec alongside the revealed config,
            # so a directly installed (never registry-named) spec
            # survives the round trip like a shared live VFS.
            cli_args[e[CLIKey.NAME]] = override
        elif override is not None:
            cli_args[e[CLIKey.NAME]] = (cli_spec_from_entry(e), override)
        else:
            cli_args[e[CLIKey.NAME]] = (
                cli_spec_from_entry(e),
                e[CLIKey.CONFIG],
            )

    saved_default = state.get(StateKey.WRITE)
    if saved_default is None or saved_default == "":
        raise WritePolicyError(
            "Workspace.load: the snapshot is missing its workspace write "
            "policy; regenerate the snapshot"
        )
    return MountArgs(
        mount_args=mount_args,
        default_session_id=state[StateKey.DEFAULT_SESSION_ID],
        clis=cli_args or None,
        write_default=coerce_write_policy(str(saved_default)),
        anchored=anchored,
        io=IOConfig.model_validate(state.get(StateKey.IO, {})),
        command_limits={
            name: Limit.model_validate(limit)
            for name, limit in state.get(StateKey.COMMAND_LIMITS, {}).items()
        },
        profiles={
            name: profile_from_dict(doc)
            for name, doc in state.get(StateKey.PROFILES, {}).items()
        },
        profile=state.get(StateKey.PROFILE),
    )


async def apply_state_dict(
    ws: WorkspaceLike,
    state: dict[str, Any],
    *,
    replace_cache: bool = False,
    built_for_state: bool = False,
    shared: frozenset[str] = frozenset(),
) -> None:
    """Restore post-construction state into an already-built Workspace.

    Restores: VFS load_state (content, fresh disk root, etc.),
    sessions, cache entries, history, finished jobs. Drops the target's
    VFS.md and SKILL.md bindings, which a snapshot never carries.

    Workspace must already have its mounts constructed via the args
    from build_mount_args. This function constructs nothing.

    Every session table and the env template clear the target's
    ``pre_session`` gate first (``_gate_restored_state``), before any
    mount, session or template lands, so a refusal aborts the load with
    the workspace as it was. A snapshot mount with no mount at that
    exact prefix here is not restored and is reported at warning level.

    Args:
        ws (WorkspaceLike): the target workspace.
        state (dict[str, Any]): the snapshot state.
        replace_cache (bool): drop the live cache once the gate has
            passed, ahead of the mounts' load_state, so the snapshot's
            entries are all that is left. A checkout onto a running
            workspace asks for this; a workspace built for the state
            has nothing to drop. It sits behind the gate because the
            callers used to clear before calling, and a refused
            checkout then still sent every cached read back to an
            origin that may have moved.
        built_for_state (bool): the workspace was just built from this
            state, under its profile table, and has run nothing: each
            session then lands the narrowing and ask decisions its table
            recorded, as a stored record hydrates. A checkout onto a
            running workspace keeps its own sessions' narrowing and
            decisions, and a table's mount caps only narrow them.
        shared (frozenset[str]): the prefixes whose mount a copy shares
            with its origin. Their VFS's content is already there, so no
            state is loaded into it at any prefix.
    """
    check_format_version(state)
    groups = vfs_groups(state)
    sessions, seed_vars = await _gate_restored_state(
        ws, state, built_for_state
    )
    # A snapshot holds no document bindings, so a load into a live
    # workspace drops its own: one left in place would shadow a file the
    # snapshot restores at the same path.
    await ws._documents.clear()
    if replace_cache:
        await ws.cache.clear()
    # load_state runs for every saved VFS (overridden too), so disk content
    # is written into the new root, redis content into the new URL, etc.
    # Cred-only mounts (S3 et al.) define load_state as no-op. Only a
    # mount a copy shares is left as it is: replaying the captured bytes
    # would undo what another writer did to it since. Every state is
    # prepared before any mount loads, so a captured disk file that is
    # gone or now a link fails the load with no mount changed. A VFS
    # saved at several prefixes loads once, and a shared one never.
    loads = []
    shared_vfs = {
        id(mount.vfs)
        for mount in ws.registry.mounts()
        if mount.prefix in shared
    }
    loaded: set[tuple[int, str]] = set()
    for m in state[StateKey.MOUNTS]:
        mount = ws.registry.try_mount_for_prefix(m[MountKey.PREFIX])
        if mount is None:
            # Exact-prefix lookup: a snapshot prefix this workspace does
            # not mount is never resolved to an ancestor (that would load
            # state into the wrong VFS), and it is said out loud,
            # since a renamed or missing mount otherwise left no trace.
            logger.warning(
                "Workspace.load: snapshot mount %s has no mount at that "
                "prefix in this workspace; its state was not restored",
                m[MountKey.PREFIX],
            )
            continue
        key = (id(mount.vfs), groups[norm_dir(m[MountKey.PREFIX])])
        if id(mount.vfs) in shared_vfs or key in loaded:
            continue
        loaded.add(key)
        vfs_state = m[MountKey.VFS_STATE]
        # A disk state loaded into another mount that keeps content (one
        # overriding load_state, as RAM and redis do, under any name)
        # takes the disk's state in RAM's shape; a mount keeping no
        # content reads no file.
        if (
            vfs_state.get(VFSStateKey.TYPE) == VFSName.DISK
            and mount.vfs.name != VFSName.DISK
            and type(mount.vfs).load_state is not BaseVFS.load_state
        ):
            vfs_state = await run_blocking(_disk_state_as_ram, vfs_state)
        loads.append((mount, vfs_state))
    for mount, vfs_state in loads:
        if mount.vfs.name in (VFSName.DISK, VFSName.REDIS):
            await run_blocking(mount.vfs.load_state, vfs_state)
        else:
            mount.vfs.load_state(vfs_state)

    await _restore_sessions(ws, state, sessions)
    # The env template is constructor state the rebuilt workspace was
    # never given: without it a session created after the load starts
    # bare while restored ones carry every workspace env entry.
    if seed_vars is not None:
        ws._session_mgr.restore_seed(seed_vars)
    _restore_cache(ws, state)
    await _restore_history(ws, state)
    await _restore_jobs(ws, state)
    await _restore_nodes(ws, state)


def _placed_vfs(
    override: BaseVFS | Mount, mount_state: dict[str, Any]
) -> tuple[BaseVFS, str | None]:
    """The VFS an override places at a saved mount, with its label.

    A ``Mount`` names the entry point it came through. A bare VFS of the
    saved class keeps the saved reference; one of another class has
    none, since the saved one names a backend it is not.

    Args:
        override (BaseVFS | Mount): what ``mounts=`` hands the prefix.
        mount_state (dict[str, Any]): the saved ``mounts`` entry.
    """
    if isinstance(override, Mount):
        return override.vfs, override.vfs_ref
    cls = type(override)
    same = (
        f"{cls.__module__}.{cls.__name__}" == mount_state[MountKey.VFS_CLASS]
    )
    return override, mount_state.get(MountKey.VFS_REF) if same else None


def _disk_state_as_ram(vfs_state: dict[str, Any]) -> dict[str, Any]:
    """A disk mount's state as a RAM mount takes it, each host file read
    through ``open_regular``, so one swapped for a link since capture is
    refused, never followed.

    Args:
        vfs_state (dict[str, Any]): a disk mount's captured state.
    """
    files: dict[str, bytes] = {}
    attrs: dict[str, dict[str, int]] = {}
    dirs = {"/"}
    modes = vfs_state.get("modes") or {}
    for rel, data in (vfs_state.get(VFSStateKey.FILES) or {}).items():
        key = "/" + rel
        if isinstance(data, Path):
            with open_regular(data) as f:
                data = f.read()
        files[key] = data
        if rel in modes:
            attrs[key] = {"mode": modes[rel]}
        dirs.update(str(p) for p in PurePosixPath(key).parents)
    return {
        VFSStateKey.TYPE: VFSName.RAM,
        VFSStateKey.FILES: files,
        VFSStateKey.DIRS: sorted(dirs),
        "attrs": attrs,
    }


async def _restore_nodes(ws: WorkspaceLike, state: dict[str, Any]) -> None:
    entries = {
        path: NodeMeta.from_fields(d)
        for path, d in (state.get(StateKey.NODES) or {}).items()
    }
    await ws.namespace.replace_nodes(entries)


async def _gate_restored_state(
    ws: WorkspaceLike, state: dict[str, Any], built_for_state: bool = False
) -> RestoredEnv:
    """Vet every env input the snapshot carries before any of it lands.

    Each session table and the env template fire the ``pre_session``
    gate (``gate_restored_vars``) here, ahead of the mounts' load_state
    and the session writes: a refusal that arrived once an earlier
    session had already been overwritten left the workspace in a state
    no snapshot describes, and one its close then persisted. The
    template is gated under the id the restore makes the default
    session, which is the session a live write of it would land in.

    On a checkout each table is judged under the policy the target
    gives its session, never the one the snapshot's own profile
    compiled, which was the source deployment's and does not land: the
    live session's for an id the target already has, and the default
    profile's for one the restore will create, which is what
    ``script_of`` answers for an id the manager does not know and the
    profile ``_restore_sessions`` then puts the created session under.
    A workspace built for the state seats every table first, its
    narrowing, ask decisions, cwd and variables, so each is judged as
    the session it records, under the policy it then runs under.

    Args:
        ws (WorkspaceLike): the target workspace.
        state (dict[str, Any]): the snapshot state.
        built_for_state (bool): see ``apply_state_dict``.

    Returns:
        The parsed session tables, and the env template or None when
        the snapshot carries none.
    """
    sessions = [
        SessionState.from_dict(s_data)
        for s_data in state.get(StateKey.SESSIONS, [])
    ]
    if built_for_state:
        mgr = ws._session_mgr
        for fields in sessions:
            sid = fields.session_id
            session = mgr.get(sid) if mgr.has(sid) else mgr.create(sid)
            narrow(session, narrowing_of(fields))
            session.decisions = fields.decisions
            set_cwd(session, fields.cwd)
            session.vars = fields.vars
    for fields in sessions:
        await gate_restored_vars(ws.policies, fields.session_id, fields.vars)
    seed = state.get(StateKey.ENV)
    if not seed:
        return sessions, None
    default_sid = state.get(StateKey.DEFAULT_SESSION_ID)
    seed_vars = vars_from_fields(seed)
    await gate_restored_vars(
        ws.policies,
        ws._session_mgr.default_id if default_sid is None else default_sid,
        seed_vars,
    )
    return sessions, seed_vars


async def _restore_sessions(
    ws: WorkspaceLike, state: dict[str, Any], tables: list[SessionState]
) -> None:
    default_sid = state.get(StateKey.DEFAULT_SESSION_ID)
    # Every session the snapshot restores is a new one to the agent
    # tools, so none keeps what was read before.
    ws._forget_reads()
    if default_sid is not None:
        # The snapshot's default session identity wins over the live
        # one, and the discovery record's pointer follows it.
        await ws._adopt_default_session(default_sid)
    restored: list[Any] = []
    for fields in tables:
        sid = fields.session_id
        if ws._session_mgr.has(sid):
            # The session already exists, live on a running workspace,
            # seated by the gate on one built for the state, or the
            # default adopted above: the restored state wins, matching
            # the replace_from_snapshot contract below.
            session = ws._session_mgr.get(sid)
        else:
            session = ws._session_mgr.create(sid)
            # A session the restore creates is one created without a
            # profile name, so it runs under the document's default:
            # the policy `_gate_restored_state` judged its table under,
            # where a bare session ran under none.
            compiled = ws._session_mgr.default_profile
            if compiled is not None:
                narrow(session, compiled)
        set_cwd(session, fields.cwd)
        session.vars = fields.vars
        session.functions = fields.functions
        # A restored function runs as a parse of its own, as one loaded
        # from storage does: the sites of what it replaced are gone.
        session._function_sites.clear()
        session.readonly_functions = fields.readonly_functions
        session.exported_functions = fields.exported_functions
        # The caps are narrowing, which a checkout keeps: the table's
        # narrow the session's further and never lift one it holds.
        session.mount_modes = stricter_modes(
            session.mount_modes, fields.mount_modes
        )
        restored.append(session)
    # The snapshot's session table wins over prior store contents,
    # mirroring Namespace.replace_nodes.
    await ws._session_mgr.replace_from_snapshot(restored)


def _restore_cache(ws: WorkspaceLike, state: dict[str, Any]) -> None:
    cache_state = state.get(StateKey.CACHE) or {}
    if hasattr(ws.cache, "max_drain_bytes"):
        ws.cache.max_drain_bytes = cache_state.get(CacheKey.MAX_DRAIN_BYTES)
    cache = ws.cache
    if not isinstance(cache, RAMFileCacheStore):
        # Non-RAM cache backend (e.g. Redis) — skip; its content lives
        # outside the workspace and isn't part of the snapshot anyway.
        return
    # A snapshot is a third entry point into the entry table, and a document is
    # not obliged to spell "no token" the way this version does, so each
    # token is folded the way the live write entry points fold it.
    for entry in cache_state.get(CacheKey.ENTRIES, []):
        key = entry[CacheKey.KEY]
        data = entry[CacheKey.DATA]
        cache._store.files[key] = data
        cache._entries[key] = CacheEntry(
            size=entry.get(CacheKey.SIZE, len(data)),
            cached_at=entry.get(CacheKey.CACHED_AT, 0),
            fingerprint=entry.get(CacheKey.FINGERPRINT) or None,
            ttl=entry.get(CacheKey.TTL),
        )
        cache._cache_size += entry.get(CacheKey.SIZE, len(data))


async def _restore_history(ws: WorkspaceLike, state: dict[str, Any]) -> None:
    # Always load (load_events clears first): a snapshot with empty
    # history still rewinds the recorder, same as the cache clear.
    await ws.observer.load_events(state.get(StateKey.HISTORY) or [])


async def _restore_jobs(ws: WorkspaceLike, state: dict[str, Any]) -> None:
    for job_d in state.get(StateKey.JOBS, []):
        await ws.job_table.load(_job_from_dict(job_d))


async def _job_to_dict(job: Job) -> dict[str, Any]:
    """Serialize one finished job.

    Output is stored per channel rather than chunk by chunk: the manifest
    externalizes byte fields into tar entries, so keeping chunks would
    write one tar entry per write a job ever made. The cost is that a
    restored job's stdout and stderr no longer interleave, which only
    affects jobs that have already ended.

    Args:
        job (Job): the finished job to serialize.
    """
    return {
        JobKey.ID: job.id,
        JobKey.COMMAND: job.command,
        JobKey.CWD: job.cwd,
        JobKey.STATUS: job.status.value,
        JobKey.STDOUT: await job.console.snapshot(Channel.STDOUT),
        JobKey.STDERR: await job.console.snapshot(Channel.STDERR),
        JobKey.EXIT_CODE: job.exit_code,
        JobKey.CREATED_AT: job.created_at,
        JobKey.SESSION_ID: job.session_id,
        JobKey.EXECUTION_ID: job.execution_id,
    }


def _restored_console(
    d: dict[str, Any], exit_code: int, status: JobStatus
) -> JobConsole:
    """Rebuild a finished job's console from its serialized output.

    Args:
        d (dict[str, Any]): the serialized job.
        exit_code (int): the job's exit status.
        status (JobStatus): how the job ended.
    """
    ts = d.get(JobKey.CREATED_AT, 0.0)
    chunks: list[ConsoleChunk] = []
    for channel, key in (
        (Channel.STDOUT, JobKey.STDOUT),
        (Channel.STDERR, JobKey.STDERR),
    ):
        data = d.get(key, b"") or b""
        if data:
            chunks.append(
                ConsoleChunk(
                    seq=len(chunks), ts=ts, channel=channel, data=data
                )
            )
    outcome = (
        killed_outcome(exit_code)
        if status == JobStatus.KILLED
        else exit_outcome(exit_code)
    )
    chunks.append(
        ConsoleChunk(
            seq=len(chunks),
            ts=ts,
            channel=Channel.CONTROL,
            data=outcome.encode(),
        )
    )
    console = JobConsole(RAMConsoleStore(chunks=chunks), finished=True)
    if execution_id := d.get(JobKey.EXECUTION_ID):
        console.bind_execution(execution_id)
    return console


def _job_from_dict(d: dict[str, Any]) -> Job:
    status = JobStatus(d.get(JobKey.STATUS, JobStatus.COMPLETED.value))
    exit_code = d.get(JobKey.EXIT_CODE, 0)
    return Job(
        id=d[JobKey.ID],
        command=d[JobKey.COMMAND],
        cwd=d.get(JobKey.CWD, "/"),
        status=status,
        exit_code=exit_code,
        console=_restored_console(d, exit_code, status),
        created_at=d.get(JobKey.CREATED_AT, 0.0),
        session_id=d.get(JobKey.SESSION_ID, "default"),
    )


def _construct_vfs(mount_state: dict[str, Any]) -> BaseVFS:
    """Rebuild a saved mount's VFS the way ``build_vfs`` would.

    Args:
        mount_state (dict[str, Any]): one captured ``mounts`` entry that
            ``requires_vfs_override`` answered False for.
    """
    cls, entry = _saved_class(mount_state)
    if cls is None:
        raise ValueError(
            f"cannot rebuild the mount at {mount_state[MountKey.PREFIX]}: "
            f"{mount_state[MountKey.VFS_CLASS]} is not importable"
        )
    vfs_state = mount_state[MountKey.VFS_STATE]
    ptype = vfs_state.get(VFSStateKey.TYPE, "")

    if ptype in (VFSName.RAM, VFSName.DISK):
        saved = vfs_state.get(VFSStateKey.CONFIG) or {}
        knobs = {
            key: saved[key] for key in ("folder_versions",) if key in saved
        }
        for key in unknown_kwargs(cls, knobs):
            del knobs[key]
        if ptype == VFSName.RAM:
            built = cls(**knobs)
        else:
            built = cls(root=tempfile.mkdtemp(prefix="mirage-disk-"), **knobs)
    elif ptype == VFSName.REDIS:
        raise ValueError(
            f"Redis mount at {mount_state[MountKey.PREFIX]} requires "
            "mounts= override"
        )
    else:
        config = vfs_state.get(VFSStateKey.CONFIG)
        config_cls = _saved_config_class(cls, entry)
        if config is None:
            built = cls()
        elif config_cls is not None:
            built = cls(config_cls(**config))
        else:
            built = cls(**config)
    return cast(BaseVFS, built)


def requires_vfs_override(mount_state: dict[str, Any]) -> bool:
    """Whether a saved mount must be handed back live rather than rebuilt.

    Three reasons, and TypeScript's ``vfsStateRequiresOverride``
    reads the first two the same way: the VFS said so
    (``needs_override``, which a driver built from a table writes by
    default because the base cannot know a subclass's constructor), a
    config secret was redacted, or the class is one this process cannot
    import (a script file loaded under the loader's module name with no
    reference recorded, or a class from a package that is not
    installed). The redaction check scans every saved value rather than
    the secret fields of the class the mount resolves to: an alias
    VFS (MinIO) saves its own config under its parent's ``type``,
    so that class named the wrong fields and a redacted key rebuilt as
    the literal marker.

    Args:
        mount_state (dict[str, Any]): one captured ``mounts`` entry.
    """
    vfs_state = mount_state[MountKey.VFS_STATE]
    if vfs_state.get(VFSStateKey.NEEDS_OVERRIDE) is True:
        return True
    cls, _entry = _saved_class(mount_state)
    if cls is None:
        return True
    return has_redacted_secret(vfs_state.get(VFSStateKey.CONFIG))


def reusable_clis(ws: WorkspaceLike) -> CLIOverrides:
    """Live-install overrides a same-process copy reinstalls from.

    Each override carries the live CLI and the revealed config, the
    way remote mounts share their live mounts: a directly installed
    spec (never named in the global registry) and a redacted secret
    both survive without a registry lookup.

    Args:
        ws (WorkspaceLike): the origin workspace.
    """
    overrides: CLIOverrides = {}
    for name, install in ws.registry.clis.items().items():
        overrides[name] = (
            install.cli,
            cli_config_dump(install.config, reveal=True),
        )
    return overrides


def reusable_mounts(
    mounts: list[Any], state: dict[str, Any]
) -> dict[str, Any]:
    """Live mounts a copy should share with its origin.

    Remote backends (S3, Redis, GDrive) stay shared: their state
    redacts the secrets a reconstruction would need. Local content
    mounts (RAM, Disk) are rebuilt fresh so the copy's writes do
    not clobber the original's data. The auto mounts are excluded
    because the new workspace mounts its own.

    Args:
        mounts (list[Any]): the origin's mount entries.
        state (dict[str, Any]): the origin's state dict.
    """
    auto = {
        "/dev/",
        norm_dir(HISTORY_PREFIX),
        norm_dir(BIN_PREFIX),
    }
    live = {
        m.prefix: Mount(vfs=m.vfs, read=m.read, vfs_ref=m.vfs_ref)
        for m in mounts
        if m.prefix not in auto
    }
    leaders = vfs_leaders(state)
    return {
        m[MountKey.PREFIX]: live[m[MountKey.PREFIX]]
        for m in state[StateKey.MOUNTS]
        if m[MountKey.PREFIX] in live
        and requires_vfs_override(leaders[norm_dir(m[MountKey.PREFIX])])
    }


def _saved_entry(mount_state: dict[str, Any]) -> VFSEntry | None:
    """The registry entry a saved mount rebuilds through, or None.

    The ``vfs_ref`` the registry built the mount from when one was
    recorded (a registered name, or a colon reference, which is how a
    mount declared as ``./wiki.py:WikiVFS`` comes back), else the
    builtin entry whose class is the saved class, else the VFS's
    ``type``, the last locator a VFS constructed in code leaves. The
    ref comes first because ``type`` is the class's ``name`` and a
    subclass inherits it: an alias registered over a builtin, or a
    script subclassing one, reports the builtin's type and rebuilt as
    the builtin while the type was consulted first. A recorded ref this
    process cannot resolve is not a reason to fall back to that guess;
    ``_saved_class`` imports the class the snapshot names as the last
    resort, and the loader asks for an override when even that fails.

    Args:
        mount_state (dict[str, Any]): one captured ``mounts`` entry.
    """
    ref = mount_state.get(MountKey.VFS_REF)
    if ref:
        return resolve_entry(ref)
    entry = _builtin_entry_for_class(mount_state[MountKey.VFS_CLASS])
    if entry is not None:
        return entry
    ptype = mount_state[MountKey.VFS_STATE].get(VFSStateKey.TYPE, "")
    return resolve_entry(ptype) if ptype else None


def _builtin_entry_for_class(cls_path: str) -> VFSEntry | None:
    """The builtin entry that builds exactly the saved class, or None.

    A mount constructed in code records no ref, and its ``type`` is the
    class's ``name``, which a subclass inherits unless it declares its
    own: a subclass of a builtin that keeps the builtin's name saves its
    own config under the builtin's type, and rebuilding through the
    type's entry hands that config to the builtin's config class, which
    refuses the keys it does not know. (The S3-compatible aliases once
    did exactly this under ``s3``; each now carries its own name.) The
    saved class path names the class that was running, so the entry
    whose class it is -- matched by identity, after narrowing by class
    name so only that candidate is imported -- is the one to rebuild
    through.

    Args:
        cls_path (str): the saved ``module.ClassName``.
    """
    mod_name, separator, cls_name = cls_path.rpartition(".")
    if not separator:
        return None
    if mod_name == SCRIPT_MODULE_NAME:
        return None
    for entry in REGISTRY.values():
        ref = entry.vfs_path
        name = ref.__name__ if isinstance(ref, type) else ref.rsplit(":")[-1]
        if name != cls_name:
            continue
        cls = resolve_class(ref)
        if f"{cls.__module__}.{cls.__name__}" == cls_path:
            return entry
    return None


def _saved_class(
    mount_state: dict[str, Any],
) -> tuple[type | None, VFSEntry | None]:
    """The class a saved mount is rebuilt from, with its registry entry.

    ``(None, None)`` when this process cannot reach the class: it ran
    from a script file with no reference recorded, or its package is not
    installed. The caller decides what that means (an override is
    required); nothing here guesses.

    Args:
        mount_state (dict[str, Any]): one captured ``mounts`` entry.
    """
    entry = _saved_entry(mount_state)
    if entry is not None:
        return resolve_class(entry.vfs_path), entry
    cls_path = mount_state[MountKey.VFS_CLASS]
    mod_name, separator, cls_name = cls_path.rpartition(".")
    if not separator or mod_name == SCRIPT_MODULE_NAME:
        return None, None
    try:
        module = importlib.import_module(mod_name)
    except ImportError as exc:
        logger.debug("saved VFS class %s is not importable: %s", cls_path, exc)
        return None, None
    return getattr(module, cls_name, None), None


def _saved_config_class(vfs_cls: type, entry: VFSEntry | None) -> type | None:
    """The typed config a saved mount's constructor takes, or None.

    The registry entry's config class when the entry declares one, else
    the class's own ``CONFIG_CLS``: exactly what ``build_vfs``
    reads. It used to scan the class's module for the first name ending
    in ``Config``, which picked a neighbour by alphabet.

    Args:
        vfs_cls (type): the VFS class being rebuilt.
        entry (VFSEntry | None): its registry entry, when it has one.
    """
    if entry is not None and entry.config_path is not None:
        return resolve_class(entry.config_path)
    ref = getattr(vfs_cls, "CONFIG_CLS", None)
    return None if ref is None else resolve_class(ref)
