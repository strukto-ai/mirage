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
import logging
import tempfile
from typing import Any, cast, get_args

from pydantic import BaseModel

from mirage.commands.cli.types import CLISpec
from mirage.observe.log_entry import EVENT_CLEAR, EVENT_COMMAND, EVENT_DELETE
from mirage.resource.history import HISTORY_PREFIX
from mirage.resource.loader import SCRIPT_MODULE_NAME
from mirage.resource.registry import (ResourceEntry, resolve_class,
                                      resolve_entry)
from mirage.resource.secrets import (has_redacted_secret, redacted_config_dump,
                                     revealed_config_dump)
from mirage.runtime.types import Language, ScriptSource
from mirage.shell.console import (KILLED_OUTCOME, Channel, ConsoleChunk,
                                  JobConsole, RAMConsoleStore, exit_outcome)
from mirage.shell.job_table import Job, JobStatus
from mirage.types import ConsistencyPolicy, JsonValue, MountMode, ResourceName
from mirage.version import __version__
from mirage.workspace.mount.namespace import NodeMeta
from mirage.workspace.session.session import (Session, vars_from_fields,
                                              vars_to_fields)
from mirage.workspace.session.shell_dirs import set_cwd
from mirage.workspace.snapshot.config import MountArgs
from mirage.workspace.snapshot.drift import (capture_fingerprints,
                                             live_only_mount_prefixes)
from mirage.workspace.snapshot.keys import (CacheKey, CLIKey, JobKey, MountKey,
                                            ResourceStateKey, ScriptKey,
                                            SessionKey, StateKey)
from mirage.workspace.snapshot.utils import FORMAT_VERSION, norm_mount_prefix

logger = logging.getLogger(__name__)

# A per-name override for restoring installed CLIs: a plain mapping is a
# fresh config (the spec resolves from the snapshot's registry key); a
# (spec, config) tuple carries a live spec too, which is how copy()
# shares directly installed programs.
CLIOverrides = dict[str, dict[str, Any]
                    | tuple[str | CLISpec, dict[str, Any] | None]]


def cli_config_dump(config: BaseModel | dict[str, JsonValue] | None,
                    reveal: bool = False) -> dict[str, Any] | None:
    """Serialize an installation's config for a snapshot.

    A model-backed config redacts (or reveals, for a same-process copy)
    its schema-declared secrets. A script install's config is an opaque
    mapping instead: with no ``config_model`` nothing declares which
    keys are secret, so it is captured verbatim rather than guessed at,
    and a script CLI that needs a credential reads it from a managed
    env var. The yaml door refuses a secrets pointer in a script's
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
        return (revealed_config_dump(config)
                if reveal else redacted_config_dump(config))
    return dict(config)


def cli_snapshot(name: str, install) -> dict[str, Any]:
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
        CLIKey.SPEC: install.spec.name,
        CLIKey.CONFIG: cli_config_dump(install.config),
    }
    script = install.spec.script
    if script is not None:
        entry[CLIKey.SCRIPT] = {
            ScriptKey.SOURCE: script.source,
            ScriptKey.LANGUAGE: script.language,
            ScriptKey.MODULE: script.module,
        }
        entry[CLIKey.RUNTIME] = install.spec.runtime
    return entry


def cli_spec_from_entry(entry: dict[str, Any]) -> str | CLISpec:
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
        raise ValueError(f"snapshot cli {name!r}: unknown script language "
                         f"{language!r}")
    return CLISpec(name=name,
                   script=ScriptSource(str(script[ScriptKey.SOURCE]),
                                       language=cast(Language, language),
                                       module=bool(script.get(
                                           ScriptKey.MODULE))),
                   runtime=entry.get(CLIKey.RUNTIME))


async def to_state_dict(ws) -> dict[str, Any]:
    auto_prefixes = {"/dev/", norm_mount_prefix(HISTORY_PREFIX)}

    mounted = ws._registry.mounts()
    for mount in mounted:
        await mount.ensure_ready()
    mounts_state = []
    for idx, m in enumerate(mt for mt in mounted
                            if mt.prefix not in auto_prefixes):
        async with m.use():
            resource_state = m.resource.get_state()
        mounts_state.append({
            MountKey.INDEX: idx,
            MountKey.PREFIX: m.prefix,
            MountKey.MODE: m.mode.value,
            MountKey.CONSISTENCY: m.consistency.value,
            MountKey.RESOURCE_CLASS:
            f"{type(m.resource).__module__}.{type(m.resource).__name__}",
            MountKey.RESOURCE_REF: m.resource.resource_ref,
            MountKey.RESOURCE_STATE: resource_state,
        })

    cache = ws._cache
    cache_entries = [{
        CacheKey.KEY: k,
        CacheKey.DATA: cache._store.files.get(k, b""),
        CacheKey.FINGERPRINT: e.fingerprint,
        CacheKey.TTL: e.ttl,
        CacheKey.CACHED_AT: e.cached_at,
        CacheKey.SIZE: e.size,
    } for k, e in cache._entries.items()]

    history_events = [
        e for e in await ws.observer.events()
        if e.get("type") in (EVENT_COMMAND, EVENT_CLEAR, EVENT_DELETE)
    ]

    clis_state = [
        cli_snapshot(name, install)
        for name, install in ws._registry.clis.items().items()
    ]

    finished_jobs = [
        await _job_to_dict(j) for j in ws.job_table.list_jobs()
        if j.status != JobStatus.RUNNING
    ]

    if mounted != ws._registry.mounts() or any(m.retiring for m in mounted):
        raise RuntimeError("mounts changed during snapshot")
    fingerprints = capture_fingerprints(ws)
    live_only_mounts = live_only_mount_prefixes(ws)

    return {
        StateKey.VERSION: FORMAT_VERSION,
        StateKey.MIRAGE_VERSION: __version__,
        StateKey.MOUNTS: mounts_state,
        StateKey.SESSIONS: [s.to_dict() for s in ws._session_mgr.list()],
        StateKey.ENV: vars_to_fields(ws._session_mgr.seed_vars),
        StateKey.DEFAULT_SESSION_ID: ws._session_mgr.default_id,
        StateKey.DEFAULT_AGENT_ID: ws._default_agent_id,
        StateKey.CURRENT_AGENT_ID: ws._default_agent_id,
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
            path: meta.to_fields()
            for path, meta in ws._namespace.nodes.items()
        },
    }


def build_mount_args(state: dict[str, Any],
                     resources: dict[str, Any] | None = None,
                     clis: CLIOverrides | None = None) -> MountArgs:
    """Translate a state dict into Workspace constructor inputs.

    Validates that every mount with redacted secrets has a resource
    override, and every CLI installed with a redacted config has a
    fresh config override.
    Does NOT construct a Workspace — that's the caller's job.

    Raises:
        ValueError: if any redacted mount or CLI lacks an override, or
            if the snapshot is from an unsupported format version.
    """
    saved_version = state.get(StateKey.VERSION)
    if saved_version is not None and saved_version < FORMAT_VERSION:
        raise ValueError(f"snapshot format v{saved_version} not supported "
                         f"(loader expects v{FORMAT_VERSION}); "
                         "regenerate via `mirage workspace snapshot`")

    overrides = {norm_mount_prefix(k): v for k, v in (resources or {}).items()}

    missing = [
        m[MountKey.PREFIX] for m in state[StateKey.MOUNTS]
        if requires_resource_override(m)
        and norm_mount_prefix(m[MountKey.PREFIX]) not in overrides
    ]
    if missing:
        raise ValueError(
            "Workspace.load: resources= must include overrides for: "
            f"{missing}. A listed mount was saved with redacted "
            "credentials, asked to be handed back live (needs_override), "
            "or names a class this process cannot import; register the "
            "class (register_resource) or pass a live instance.")

    cli_overrides = clis or {}
    cli_entries = state.get(StateKey.CLIS) or []
    missing_clis = [
        e[CLIKey.NAME] for e in cli_entries
        if has_redacted_secret(e[CLIKey.CONFIG])
        and e[CLIKey.NAME] not in cli_overrides
    ]
    if missing_clis:
        raise ValueError(
            "Workspace.load: clis= must include fresh configs for: "
            f"{missing_clis}. These CLIs were saved with redacted "
            "config secrets.")

    mount_args: dict[str, tuple[Any, ...]] = {}
    for m in state[StateKey.MOUNTS]:
        prefix = norm_mount_prefix(m[MountKey.PREFIX])
        prov = (overrides[prefix]
                if prefix in overrides else _construct_resource(m))
        mount_args[m[MountKey.PREFIX]] = (prov, MountMode(m[MountKey.MODE]))

    cli_args: dict[str, tuple[str | CLISpec, dict[str, Any] | None]] = {}
    for e in cli_entries:
        override = cli_overrides.get(e[CLIKey.NAME])
        if isinstance(override, tuple):
            # copy() shares the live spec alongside the revealed config,
            # so a directly installed (never registry-named) spec
            # survives the round trip like a shared live resource.
            cli_args[e[CLIKey.NAME]] = override
        elif override is not None:
            cli_args[e[CLIKey.NAME]] = (cli_spec_from_entry(e), override)
        else:
            cli_args[e[CLIKey.NAME]] = (cli_spec_from_entry(e),
                                        e[CLIKey.CONFIG])

    return MountArgs(
        mount_args=mount_args,
        consistency=ConsistencyPolicy.LAZY,
        default_session_id=state[StateKey.DEFAULT_SESSION_ID],
        default_agent_id=state.get(StateKey.DEFAULT_AGENT_ID),
        clis=cli_args or None,
    )


async def apply_state_dict(ws, state: dict[str, Any]) -> None:
    """Restore post-construction state into an already-built Workspace.

    Restores: resource load_state (content, fresh disk root, etc.),
    sessions, cache entries, history, finished jobs.

    Workspace must already have its mounts constructed via the args
    from build_mount_args. This function is purely additive — it does
    not construct anything.
    """
    # load_state runs for ALL mounts (overridden too), so disk content
    # is written into the new root, redis content into the new URL, etc.
    # Cred-only resources (S3 et al.) define load_state as no-op.
    for m in state[StateKey.MOUNTS]:
        mount = ws._registry.try_mount_for_prefix(m[MountKey.PREFIX])
        if mount is None:
            continue
        mount.resource.load_state(m[MountKey.RESOURCE_STATE])

    await _restore_sessions(ws, state)
    # The env template is constructor state the rebuilt workspace was
    # never given: without it a session created after the load starts
    # bare while restored ones carry every workspace env entry.
    seed = state.get(StateKey.ENV)
    if seed:
        ws._session_mgr.restore_seed(vars_from_fields(seed))
    # current_agent_id is not restored: the agent of a line is carried
    # per execution (the call's agent_id, else the default), never held
    # on the workspace, so the key only mirrors default_agent_id.
    _restore_cache(ws, state)
    await _restore_history(ws, state)
    _restore_jobs(ws, state)
    await _restore_nodes(ws, state)


async def _restore_nodes(ws, state: dict[str, Any]) -> None:
    entries = {
        path: NodeMeta.from_fields(d)
        for path, d in (state.get(StateKey.NODES) or {}).items()
    }
    await ws._namespace.replace_nodes(entries)


async def _restore_sessions(ws, state: dict[str, Any]) -> None:
    default_sid = state.get(StateKey.DEFAULT_SESSION_ID)
    if default_sid is not None:
        # The snapshot's default session identity wins over the live
        # one, and the discovery record's pointer follows it.
        ws._session_mgr.adopt_default(default_sid)
        ws._default_session_id = default_sid
        await ws._state_store.replace_meta(ws._workspace_id, {
            "workspace_id": ws._workspace_id,
            "default_session_id": default_sid,
        })
        ws._meta_written = True
    restored: list[Any] = []
    for s_data in state.get(StateKey.SESSIONS, []):
        sid = s_data[SessionKey.SESSION_ID]
        if sid == default_sid:
            session = ws._session_mgr.get(sid)
        else:
            try:
                session = ws._session_mgr.create(sid)
            except ValueError:
                # The session already exists live (checkout on a
                # running workspace): the restored state wins, matching
                # the replace_from_snapshot contract below.
                session = ws._session_mgr.get(sid)
        fields = Session.from_dict(s_data)
        set_cwd(session, fields.cwd)
        session.vars = fields.vars
        session.mount_modes = fields.mount_modes
        restored.append(session)
    # The snapshot's session table wins over prior store contents,
    # mirroring Namespace.replace_nodes.
    await ws._session_mgr.replace_from_snapshot(restored)


def _restore_cache(ws, state: dict[str, Any]) -> None:
    cache_state = state.get(StateKey.CACHE) or {}
    if hasattr(ws._cache, "max_drain_bytes"):
        ws._cache.max_drain_bytes = cache_state.get(CacheKey.MAX_DRAIN_BYTES)
    cache = ws._cache
    if not hasattr(cache, "_entries") or not hasattr(cache, "_store"):
        # Non-RAM cache backend (e.g. Redis) — skip; its content lives
        # outside the workspace and isn't part of the snapshot anyway.
        return
    from mirage.cache.file.entry import CacheEntry
    for entry in cache_state.get(CacheKey.ENTRIES, []):
        key = entry[CacheKey.KEY]
        data = entry[CacheKey.DATA]
        cache._store.files[key] = data
        cache._entries[key] = CacheEntry(
            size=entry.get(CacheKey.SIZE, len(data)),
            cached_at=entry.get(CacheKey.CACHED_AT, 0),
            fingerprint=entry.get(CacheKey.FINGERPRINT),
            ttl=entry.get(CacheKey.TTL),
        )
        cache._cache_size += entry.get(CacheKey.SIZE, len(data))


async def _restore_history(ws, state: dict[str, Any]) -> None:
    # Always load (load_events clears first): a snapshot with empty
    # history still rewinds the recorder, same as the cache clear.
    await ws.observer.load_events(state.get(StateKey.HISTORY) or [])


def _restore_jobs(ws, state: dict[str, Any]) -> None:
    max_id = 0
    for job_d in state.get(StateKey.JOBS, []):
        max_id = max(max_id, job_d.get(JobKey.ID, 0))
        ws.job_table._jobs[job_d[JobKey.ID]] = _job_from_dict(job_d)
    ws.job_table._next_id = max_id + 1


async def _job_to_dict(job) -> dict[str, Any]:
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
        JobKey.AGENT: job.agent,
        JobKey.SESSION_ID: job.session_id,
    }


def _restored_console(d: dict[str, Any], exit_code: int,
                      status: JobStatus) -> JobConsole:
    """Rebuild a finished job's console from its serialized output.

    Args:
        d (dict[str, Any]): the serialized job.
        exit_code (int): the job's exit status.
        status (JobStatus): how the job ended.
    """
    ts = d.get(JobKey.CREATED_AT, 0.0)
    chunks: list[ConsoleChunk] = []
    for channel, key in ((Channel.STDOUT, JobKey.STDOUT), (Channel.STDERR,
                                                           JobKey.STDERR)):
        data = d.get(key, b"") or b""
        if data:
            chunks.append(
                ConsoleChunk(seq=len(chunks),
                             ts=ts,
                             channel=channel,
                             data=data))
    outcome = (KILLED_OUTCOME
               if status == JobStatus.KILLED else exit_outcome(exit_code))
    chunks.append(
        ConsoleChunk(seq=len(chunks),
                     ts=ts,
                     channel=Channel.CONTROL,
                     data=outcome.encode()))
    return JobConsole(RAMConsoleStore(chunks=chunks), finished=True)


def _job_from_dict(d: dict[str, Any]):
    status = JobStatus(d.get(JobKey.STATUS, JobStatus.COMPLETED.value))
    exit_code = d.get(JobKey.EXIT_CODE, 0)
    return Job(
        id=d[JobKey.ID],
        command=d[JobKey.COMMAND],
        task=None,
        cwd=d.get(JobKey.CWD, "/"),
        status=status,
        exit_code=exit_code,
        console=_restored_console(d, exit_code, status),
        created_at=d.get(JobKey.CREATED_AT, 0.0),
        agent=d.get(JobKey.AGENT, "unknown"),
        session_id=d.get(JobKey.SESSION_ID, "default"),
    )


def _construct_resource(mount_state: dict[str, Any]):
    """Rebuild a saved mount's resource the way ``build_resource`` would.

    Args:
        mount_state (dict[str, Any]): one captured ``mounts`` entry that
            ``requires_resource_override`` answered False for.
    """
    cls, entry = _saved_class(mount_state)
    if cls is None:
        raise ValueError(
            f"cannot rebuild the mount at {mount_state[MountKey.PREFIX]}: "
            f"{mount_state[MountKey.RESOURCE_CLASS]} is not importable")
    resource_state = mount_state[MountKey.RESOURCE_STATE]
    ptype = resource_state.get(ResourceStateKey.TYPE, "")

    if ptype == ResourceName.RAM:
        built = cls()
    elif ptype == ResourceName.DISK:
        built = cls(root=tempfile.mkdtemp(prefix="mirage-disk-"))
    elif ptype == ResourceName.REDIS:
        raise ValueError(
            f"Redis mount at {mount_state[MountKey.PREFIX]} requires "
            "resources= override")
    else:
        config = resource_state.get(ResourceStateKey.CONFIG)
        config_cls = _saved_config_class(cls, entry)
        if config is None:
            built = cls()
        elif config_cls is not None:
            built = cls(config_cls(**config))
        else:
            built = cls(**config)
    # Carried forward so a second round trip rebuilds through the same
    # reference; None when the original was constructed in code.
    built.resource_ref = mount_state.get(MountKey.RESOURCE_REF)
    return built


def requires_resource_override(mount_state: dict[str, Any]) -> bool:
    """Whether a saved mount must be handed back live rather than rebuilt.

    Three reasons, and TypeScript's ``resourceStateRequiresOverride``
    reads the first two the same way: the resource said so
    (``needs_override``, which ``GenericResource`` writes by default
    because the base cannot know a subclass's constructor), a config
    secret was redacted, or the class is one this process cannot import
    (a script file loaded under the loader's module name with no
    reference recorded, or a class from a package that is not
    installed).

    Args:
        mount_state (dict[str, Any]): one captured ``mounts`` entry.
    """
    resource_state = mount_state[MountKey.RESOURCE_STATE]
    if resource_state.get(ResourceStateKey.NEEDS_OVERRIDE) is True:
        return True
    cls, entry = _saved_class(mount_state)
    if cls is None:
        return True
    config = resource_state.get(ResourceStateKey.CONFIG)
    return has_redacted_secret(config, _saved_config_class(cls, entry))


def reusable_clis(ws) -> CLIOverrides:
    """Live-install overrides a same-process copy reinstalls from.

    Each override carries the live CLISpec and the revealed config, the
    way remote mounts share their live resources: a directly installed
    spec (never named in the global registry) and a redacted secret
    both survive without a registry lookup.

    Args:
        ws: the origin workspace.
    """
    overrides: CLIOverrides = {}
    for name, install in ws._registry.clis.items().items():
        overrides[name] = (install.spec,
                           cli_config_dump(install.config, reveal=True))
    return overrides


def reusable_resources(mounts: list[Any], state: dict[str,
                                                      Any]) -> dict[str, Any]:
    """Live resources a copy should share with its origin.

    Remote backends (S3, Redis, GDrive) stay shared: their state
    redacts the secrets a reconstruction would need. Local content
    resources (RAM, Disk) are rebuilt fresh so the copy's writes do
    not clobber the original's data. The auto mounts are excluded
    because the new workspace mounts its own.

    Args:
        mounts (list[Any]): the origin's mount entries.
        state (dict[str, Any]): the origin's state dict.
    """
    auto = {"/dev/", norm_mount_prefix(HISTORY_PREFIX)}
    live = {m.prefix: m.resource for m in mounts if m.prefix not in auto}
    return {
        m[MountKey.PREFIX]: live[m[MountKey.PREFIX]]
        for m in state[StateKey.MOUNTS]
        if requires_resource_override(m) and m[MountKey.PREFIX] in live
    }


def _saved_entry(mount_state: dict[str, Any]) -> ResourceEntry | None:
    """The registry entry a saved mount rebuilds through, or None.

    The ``resource_ref`` the registry built the mount from when one was
    recorded (a registered name, or a colon reference, which is how a
    mount declared as ``./wiki.py:WikiResource`` comes back), else the
    resource's ``type``, the one locator a resource constructed in code
    leaves. The ref comes first because ``type`` is the class's ``name``
    and a subclass inherits it: an alias registered over a builtin, or a
    script subclassing one, reports the builtin's type and rebuilt as
    the builtin while the type was consulted first. A recorded ref this
    process cannot resolve is not a reason to fall back to that guess;
    ``_saved_class`` imports the class the snapshot names as the last
    resort, and the loader asks for an override when even that fails.

    Args:
        mount_state (dict[str, Any]): one captured ``mounts`` entry.
    """
    ref = mount_state.get(MountKey.RESOURCE_REF)
    if ref:
        return resolve_entry(ref)
    ptype = mount_state[MountKey.RESOURCE_STATE].get(ResourceStateKey.TYPE, "")
    return resolve_entry(ptype) if ptype else None


def _saved_class(
        mount_state: dict[str,
                          Any]) -> tuple[type | None, ResourceEntry | None]:
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
        return resolve_class(entry.resource_path), entry
    cls_path = mount_state[MountKey.RESOURCE_CLASS]
    mod_name, cls_name = cls_path.rsplit(".", 1)
    if mod_name == SCRIPT_MODULE_NAME:
        return None, None
    try:
        module = importlib.import_module(mod_name)
    except ImportError as exc:
        logger.debug("saved resource class %s is not importable: %s", cls_path,
                     exc)
        return None, None
    return getattr(module, cls_name, None), None


def _saved_config_class(resource_cls: type,
                        entry: ResourceEntry | None) -> type | None:
    """The typed config a saved mount's constructor takes, or None.

    The registry entry's config class when the entry declares one, else
    the class's own ``CONFIG_CLS``: exactly what ``build_resource``
    reads. It used to scan the class's module for the first name ending
    in ``Config``, which picked a neighbour by alphabet.

    Args:
        resource_cls (type): the resource class being rebuilt.
        entry (ResourceEntry | None): its registry entry, when it has one.
    """
    if entry is not None and entry.config_path is not None:
        return resolve_class(entry.config_path)
    ref = getattr(resource_cls, "CONFIG_CLS", None)
    return None if ref is None else resolve_class(ref)
