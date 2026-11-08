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

import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PrivateAttr,
    StrictFloat,
    field_validator,
    model_validator,
)

from mirage.cache.file.config import CacheConfig, RedisCacheConfig
from mirage.cache.index.config import IndexConfig, RedisIndexConfig
from mirage.commands.cli import mcp
from mirage.commands.cli.mcp.constants import NAME as MCP_CLI
from mirage.commands.cli.types import CLI
from mirage.commands.spec.types import CommandSpec
from mirage.execution.process.config import ProcessPermissions
from mirage.io.config import IOConfig
from mirage.io.network import (
    NetworkRule,
    NetworkSetting,
    narrowed,
    network_bound,
    network_layer,
    network_routes,
    run_with_network,
)
from mirage.machine.handle import MachineHandle
from mirage.machine.registry import build_machine
from mirage.policy.constants import METHODS
from mirage.policy.profile import (
    ProfilePolicy,
    SessionProfile,
    compile_program,
)
from mirage.policy.types import ProfileScript, ProfileScripts
from mirage.rs.document import validate_document
from mirage.runtime.base import Runtime
from mirage.runtime.table import NAMED, build_runtime
from mirage.runtime.types import Language, ScriptSource
from mirage.secrets.config import EnvVar, SecretSource
from mirage.secrets.sources import (
    config_holds_pointer,
    fetched_values,
    resolve_config_secrets,
    resolve_sources_for,
)
from mirage.secrets.summary import mask_values
from mirage.types import (
    KERNEL_BACKENDS,
    Limit,
    MountBackend,
    MountMode,
    ReadPolicy,
    WritePolicy,
    parse_mount_mode,
)
from mirage.utils.clock import parse_system_time
from mirage.utils.loader import load_attr, optional_attr
from mirage.utils.size import parse_limit
from mirage.utils.yaml import parse_yaml
from mirage.vfs.registry import build_vfs
from mirage.vfs.s3.config import S3Config
from mirage.workspace.mount.read_policy import (
    coerce_read_policy,
    coerce_read_ttl,
    resolve_read_spec,
)
from mirage.workspace.mount.spec import Mount
from mirage.workspace.mount.write_policy import coerce_write_policy
from mirage.workspace.store import (
    DEFAULT_STATE_ROOT,
    DiskWorkspaceStateStore,
    RAMWorkspaceStateStore,
    WorkspaceStateStore,
)

if TYPE_CHECKING:
    from mirage.workspace.store.redis import (
        RedisWorkspaceStateStore as _RedisStore,
    )
    from mirage.workspace.store.s3 import S3WorkspaceStateStore as _S3Store

S3WorkspaceStateStore: "type[_S3Store] | None"

try:
    from mirage.workspace.store import (
        S3WorkspaceStateStore as _S3WorkspaceStateStore,
    )
except ImportError:
    S3WorkspaceStateStore = None
else:
    S3WorkspaceStateStore = _S3WorkspaceStateStore


def _coerce_mount_mode(value: Any) -> Any:
    if isinstance(value, MountMode):
        return value
    if isinstance(value, str):
        return parse_mount_mode(value.lower())
    return value


_VAR_RE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}")


def _walk_interpolate(
    value: Any, env: dict[str, str], missing: list[str]
) -> Any:
    if isinstance(value, str):

        def sub(m: re.Match[str]) -> str:
            name = m.group(1)
            if name not in env:
                missing.append(name)
                return ""
            return env[name]

        return _VAR_RE.sub(sub, value)
    if isinstance(value, dict):
        return {
            k: _walk_interpolate(v, env, missing) for k, v in value.items()
        }
    if isinstance(value, list):
        return [_walk_interpolate(v, env, missing) for v in value]
    return value


def _interpolate_env(value: Any, env: dict[str, str]) -> Any:
    """Replace ``${VAR}`` placeholders with values from ``env``.

    Args:
        value (Any): scalar, dict, or list to walk.
        env (dict[str, str]): environment mapping to read from.

    Returns:
        Any: ``value`` with every ``${VAR}`` placeholder replaced.

    Raises:
        ValueError: any referenced variable is missing from ``env``.
    """
    missing: list[str] = []
    out = _walk_interpolate(value, env, missing)
    if missing:
        unique_missing = sorted(set(missing))
        raise ValueError(f"missing environment variables: {unique_missing}")
    return out


class RamCacheBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["ram"] = "ram"
    limit: str | int = "32MB"
    max_drain_bytes: int | None = None

    @field_validator("limit", mode="before")
    @classmethod
    def _v_limit(cls, v: Any) -> Any:
        parse_limit(v, "limit")
        return v


class RedisCacheBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["redis"]
    limit: str | int = "512MB"
    max_drain_bytes: int | None = None
    url: str = "redis://localhost:6379/0"
    key_prefix: str | None = None

    @field_validator("limit", mode="before")
    @classmethod
    def _v_limit(cls, v: Any) -> Any:
        parse_limit(v, "limit")
        return v


CacheBlock = Annotated[
    RamCacheBlock | RedisCacheBlock,
    Field(discriminator="type"),
]


class RamIndexBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["ram"] = "ram"
    ttl: StrictFloat = 600


class RedisIndexBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["redis"]
    ttl: StrictFloat = 600
    url: str = "redis://localhost:6379/0"
    key_prefix: str | None = None


IndexBlock = Annotated[
    RamIndexBlock | RedisIndexBlock,
    Field(discriminator="type"),
]


class RamStoreBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["ram"] = "ram"


class DiskStoreBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["disk"]
    root: str = DEFAULT_STATE_ROOT


class RedisStoreBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["redis"]
    url: str = "redis://localhost:6379/0"
    key_prefix: str = "mirage:"


class S3StoreBlock(S3Config):
    """An ``S3Config`` plus the union discriminator: the block IS the
    backend config, so new S3Config fields flow into the store block
    without re-declaring them here."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    type: Literal["s3"]
    key_prefix: str | None = "mirage/"


StoreGroupBlock = Annotated[
    RamStoreBlock | DiskStoreBlock | RedisStoreBlock | S3StoreBlock,
    Field(discriminator="type"),
]


class StoreBlock(BaseModel):
    """The workspace state store: one block, five planes.

    The top-level type/url/key_prefix pick the default backend for
    every control-plane group (namespace nodes, observer events,
    sessions + workspace metadata, execution). The optional per-group
    overrides redirect one group to a different backend, e.g. large
    observer logs to a separate server. Sessions and workspace metadata
    move together by design (the default-session pointer must live
    beside the session table it points into), so there is one
    `workspace` override, not two. An ``s3`` group hosts only the
    sessions+meta group (conditional-PUT CAS), so it is valid as the
    ``workspace`` override, never as the top-level default. A ``disk``
    store hosts the other planes under ``root`` (lockfile CAS,
    machine-local) and keeps jobs in memory, since a job's console is a
    stream other processes follow; ``root`` is only read when a disk
    store is selected. The ``execution`` group (job lists, consoles, the
    workspace's lease, process records) is therefore ram or redis.
    """

    model_config = ConfigDict(extra="forbid")

    type: Literal["ram", "disk", "redis"] = "ram"
    url: str = "redis://localhost:6379/0"
    key_prefix: str = "mirage:"
    root: str = DEFAULT_STATE_ROOT
    namespace: StoreGroupBlock | None = None
    observer: StoreGroupBlock | None = None
    workspace: StoreGroupBlock | None = None
    execution: StoreGroupBlock | None = None

    @model_validator(mode="after")
    def _s3_hosts_only_the_workspace_group(self) -> "StoreBlock":
        """Refuse an override on a plane its store cannot host.

        The type alone permits it on any group, but ``S3WorkspaceStateStore``
        raises when asked to build a namespace or observer plane, so
        without this the config loads and the workspace fails to
        construct. History stays off Redis, and execution off disk.

        Raises:
            ValueError: an s3 group was given for namespace, observer or
                execution, redis for observer, or disk for execution.
        """
        validate_document("config", self.model_dump(), "store", names="store")
        return self


class CLIBlock(BaseModel):
    """One ``clis:`` entry: install a named CLI with its own config.

    The section key is the installed head word. Exactly one handler
    source: ``cli`` names a registered spec tree; ``script`` references
    a program file whose content is embedded at load (the docker
    build-context model). ``runtime`` optionally pins the world runtime
    entry that runs the script; unset picks the first entry speaking
    the script's language. ``config`` validates through the spec's
    ``config_model`` at install time (fail loud). A CLI never takes a
    mode and never shares a mount's credentials: a binary has no mode,
    the credential does.
    """

    model_config = ConfigDict(extra="forbid")

    cli: str | None = None
    script: str | None = None
    runtime: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _v_handler(self) -> "CLIBlock":
        if (self.cli is None) == (self.script is None):
            raise ValueError("a clis entry takes exactly one of cli or script")
        if self.runtime is not None and self.script is None:
            raise ValueError(
                "runtime pins the script's runtime; it takes script"
            )
        # A pointer may only fill a config that a model validates,
        # because the model is what a snapshot redacts by. A script's
        # config is opaque: nothing declares which key is a credential,
        # so the snapshot captures it verbatim, and a pointer resolved
        # into it would be written out as the value it fetched. The
        # block refuses rather than the dump, so every loader that reads
        # a config inherits the rule.
        if self.script is not None and config_holds_pointer(self.config):
            raise ValueError(
                "a script's config is opaque and a pointer in it would be "
                "written into every snapshot; read the credential from a "
                "managed env var instead"
            )
        return self


class MountBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    vfs: str
    mode: MountMode | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    command_limits: dict[str, Limit] = Field(default_factory=dict)
    # How the mount is exposed: workspace (default, mirage's own filesystem
    # only), fuse, or fskit. mountpoint is honored by the kernel backends.
    backend: MountBackend = MountBackend.WORKSPACE
    mountpoint: str | None = None
    # How cached bytes for this mount are revalidated, and the bound
    # that goes with `bounded`. The bound lives only in a mount block:
    # at workspace level it would sit beside `index: {ttl:}`.
    read: ReadPolicy | None = None
    ttl: int | None = None
    # Overrides the workspace `write:` as `mode` does.
    write: WritePolicy | None = None
    # Replaces the workspace `index:` whole; nothing is inherited.
    index: IndexBlock | None = None

    @field_validator("mode", mode="before")
    @classmethod
    def _v_mode(cls, v: Any) -> Any:
        if v is None:
            return v
        return _coerce_mount_mode(v)

    @field_validator("read", mode="before")
    @classmethod
    def _v_read(cls, v: Any) -> ReadPolicy | None:
        if v is None:
            return v
        return coerce_read_policy(v)

    @field_validator("write", mode="before")
    @classmethod
    def _v_write(cls, v: Any) -> WritePolicy | None:
        if v is None:
            return v
        return coerce_write_policy(v)

    @field_validator("ttl", mode="before")
    @classmethod
    def _v_ttl(cls, v: Any) -> int | None:
        # Ahead of pydantic's own coercion, which is lax where this key
        # cannot afford to be: `ttl: "30"` arrives as 30 and `ttl: true`
        # as 1, so a document TypeScript refuses outright would load
        # here and the two hosts would disagree about the same bytes --
        # `ttl: true` silently bounding the mount at one second. The
        # snapshot loader reads its bound through the same coercer.
        if v is None:
            return v
        return coerce_read_ttl(v)

    @model_validator(mode="after")
    def _v_bound(self) -> "MountBlock":
        # Two dependent-key rules, refused here rather than in the mount
        # verdict: by the time a ReadSpec exists its ttl has already
        # defaulted, so `bounded` written without a bound is
        # indistinguishable from `read:` left out entirely.
        if self.ttl is not None and self.read is None:
            raise ValueError("ttl pins the read bound; it takes read: bounded")
        if self.read is ReadPolicy.BOUNDED and self.ttl is None:
            raise ValueError("read: bounded needs a bound; set ttl:")
        # Last, so the dependent-key rules name the missing key first,
        # as TypeScript's `validateReadBlock` does. `resolve_read_spec`
        # refuses this too, but only at `to_workspace_kwargs`, which is
        # a step later than the one TypeScript refuses it at: the
        # shared `integ/fixtures/config/rejected.json` loads the config and
        # nothing more.
        if self.ttl is not None and self.ttl < 1:
            raise ValueError(f"ttl must be at least 1 second, got {self.ttl}")
        return self


def _is_script_path(value: str) -> bool:
    """True for the docker-style single-line script path form.

    Args:
        value (str): a yaml ``script`` value.
    """
    return "\n" not in value and value.strip().endswith((".py", ".js", ".mjs"))


def _load_script_source(value: str) -> ScriptSource:
    """Embed the referenced script file as source.

    Config carries a reference, the wire carries content (the docker
    build-context model): the value must be a path to a ``.py``,
    ``.js`` or ``.mjs`` file, read at load time. In code, a program is
    passed as ``ScriptSource``.

    Args:
        value (str): the yaml ``script`` value.

    Raises:
        ValueError: the value is not a script path.
        FileNotFoundError: the referenced file does not exist.
    """
    if not _is_script_path(value):
        raise ValueError(
            "a config script must reference a .py/.js file "
            f"(e.g. script: guard.py), got {value!r}"
        )
    path = Path(value.strip())
    language: Language = "js" if path.suffix in (".js", ".mjs") else "python"
    return ScriptSource(
        path.read_text(), language=language, module=path.suffix == ".mjs"
    )


def _load_program(program: ProfilePolicy) -> ProfilePolicy:
    """Embed a path-form policy program as source.

    Args:
        program (ProfilePolicy): the program as validated; returned as
            is when it already carries source.
    """
    if not isinstance(program.script, str):
        return program
    return program.model_copy(
        update={"script": _load_script_source(program.script)}
    )


def _load_profile_policy(profile: SessionProfile) -> SessionProfile:
    """Embed a profile's path-form policy programs as source.

    Args:
        profile (SessionProfile): the profile as validated; returned
            as is when it states no policy.
    """
    if profile.policy is None:
        return profile
    loaded = {
        method: [_load_program(program) for program in programs]
        for method, programs in profile.policy.items()
    }
    return profile.model_copy(update={"policy": loaded})


def _absolutize_scripts(raw: dict[str, Any], base: Path) -> None:
    """Resolve relative script paths against the config file's dir.

    A path-form ``script`` in a config file means "next to the file"
    (the docker build-context model), never "wherever the server
    happens to run". Mutates the parsed mapping in place;
    in-memory dict configs are untouched by the loader.

    Args:
        raw (dict[str, Any]): the parsed config mapping.
        base (Path): directory containing the config file.
    """
    route = raw.get("route_policy")
    if isinstance(route, dict):
        _absolutize_script_key(route, base)
    runtimes = raw.get("runtimes")
    if isinstance(runtimes, list):
        for i, entry in enumerate(runtimes):
            if isinstance(entry, dict):
                _absolutize_code_ref(entry, "name", base)
            elif isinstance(entry, str):
                runtimes[i] = _rebase_code_ref(entry, base)
    clis = raw.get("clis")
    if isinstance(clis, dict):
        for block in clis.values():
            if isinstance(block, dict):
                _absolutize_script_key(block, base)
                _absolutize_code_ref(block, "cli", base)
    mounts = raw.get("mounts")
    if isinstance(mounts, dict):
        for block in mounts.values():
            if isinstance(block, dict):
                _absolutize_code_ref(block, "vfs", base)
    profiles = raw.get("profiles")
    if isinstance(profiles, dict):
        for block in profiles.values():
            # A profile's policy programs carry their scripts the way a
            # clis entry does, so each rebases the same way.
            policy = block.get("policy") if isinstance(block, dict) else None
            if isinstance(policy, dict):
                for programs in policy.values():
                    for program in (
                        programs if isinstance(programs, list) else ()
                    ):
                        if isinstance(program, dict):
                            _absolutize_script_key(program, base)


def _absolutize_script_key(entry: dict[str, Any], base: Path) -> None:
    """Rebase one mapping's relative ``script`` path onto ``base``.

    Args:
        entry (dict[str, Any]): a ``clis`` entry, a profile ``policy``
            program or the ``route_policy`` block, mutated in place.
        base (Path): directory containing the config file.
    """
    script = entry.get("script")
    if (
        isinstance(script, str)
        and _is_script_path(script)
        and not Path(script.strip()).is_absolute()
    ):
        entry["script"] = str(base / script.strip())


def _absolutize_code_ref(entry: dict[str, Any], key: str, base: Path) -> None:
    """Rebase a path-form colon reference under ``key``.

    ``cli: ./tool.py:TREE``, ``vfs: ./wiki.py:WikiVFS`` and a
    runtime entry's ``name: ./box.py:EchoBox`` all mean "next to the
    config file", the same build-context rule ``script:`` follows;
    without this the pointer reaches ``load_attr`` relative and resolves
    against the server process's cwd. A module dotpath (``pkg.mod:TREE``)
    is left alone: importlib resolves it, not the filesystem. The split
    matches ``load_attr``'s own test, so the two cannot disagree about
    what a path is.

    Args:
        entry (dict[str, Any]): a ``clis``, ``mounts`` or ``runtimes``
            mapping entry, mutated in place.
        key (str): the field holding the reference, ``cli``,
            ``vfs`` or ``name``.
        base (Path): directory containing the config file.
    """
    ref = entry.get(key)
    if isinstance(ref, str):
        entry[key] = _rebase_code_ref(ref, base)


def _rebase_code_ref(ref: str, base: Path) -> str:
    """``ref`` with a relative path-form source rebased onto ``base``.

    Anything that is not a relative path-form reference (a bare name, a
    module dotpath, an absolute path) comes back unchanged, so the bare
    string runtime entry (``- ./box.py:EchoBox`` beside ``- monty``) reads
    the same way the keyed forms do.

    Args:
        ref (str): a config value that may be a ``source:attr`` reference.
        base (Path): directory containing the config file.
    """
    if ":" not in ref:
        return ref
    source, attr = ref.rsplit(":", 1)
    if "/" not in source and not source.endswith(".py"):
        return ref
    if Path(source).is_absolute():
        return ref
    return f"{base / source}:{attr}"


def _runtime_class(ref: str) -> type[Runtime[Any]]:
    """Load the ``Runtime`` subclass a ``source:Class`` reference names.

    The runtime twin of the ``vfs:`` and ``cli:`` reference forms:
    a deployment ships a runtime as a file and names it from yaml with no
    host program calling ``register_runtime``. The class is constructed
    with the uniform ``(captures, config)`` options like a builtin, so
    the entry's other keys reach it unchanged.

    Args:
        ref (str): ``./box.py:EchoBox`` or ``pkg.mod:EchoBox``.

    Raises:
        ValueError: the reference does not load, or names something
            that is not a ``Runtime`` subclass.
    """
    loaded = load_attr(ref)
    if not (isinstance(loaded, type) and issubclass(loaded, Runtime)):
        raise ValueError(f"{ref!r} is not a Runtime subclass")
    return loaded


def _build_runtime_entries(
    entries: list[str | dict[str, Any]],
    secrets: tuple[tuple[str, ...], ...] = (),
) -> list["Runtime[Any] | str"]:
    """Turn config runtime entries into workspace runtime entries.

    Args:
        entries (list[str | dict[str, Any]]): names, or maps carrying a
            name plus the uniform runtime options (``captures``,
            ``config``). A name is a registered runtime or a
            ``source:Class`` reference to a ``Runtime`` subclass.
        secrets (tuple[tuple[str, ...], ...]): per entry, the values its
            config read from a secret, which a refusal of it masks.

    Raises:
        ValueError: a map entry without a name, or a reference that is
            not a ``Runtime`` subclass.
    """
    out: list[Runtime[Any] | str] = []
    for i, entry in enumerate(entries):
        if isinstance(entry, str):
            out.append(_runtime_class(entry)() if ":" in entry else entry)
            continue
        options = dict(entry)
        name = options.pop("name", None)
        if not isinstance(name, str) or not name:
            raise ValueError("runtime entry needs a non-empty 'name'")
        if "machine" in options and name in NAMED and name != "machine":
            raise ValueError(
                f"runtime {name!r} runs on the workspace's machine; a"
                " machine takes the machine runtime"
            )
        try:
            out.append(
                _runtime_class(name)(**options)
                if ":" in name
                else build_runtime(name, **options)
            )
        except Exception as exc:
            # A check that quotes the value it refused would hand back a
            # secret the config read, and the create route answers this
            # message as its detail. The chain is cut for the same reason.
            masked = mask_values(
                str(exc), secrets[i] if i < len(secrets) else ()
            )
            if masked == str(exc):
                raise
            raise ValueError(masked) from None
    return out


def _build_machines(
    machines: dict[str, dict[str, Any]],
    secrets: dict[str, tuple[str, ...]],
) -> dict[str, MachineHandle]:
    """Turn the ``machines:`` block into each machine's handle.

    Args:
        machines (dict[str, dict[str, Any]]): each entry by name: its
            ``provider`` and how to reach it.
        secrets (dict[str, tuple[str, ...]]): per machine, the values
            its entry read from a secret, which a refusal of it masks.

    Raises:
        ValueError: an entry no provider builds.
    """
    out: dict[str, MachineHandle] = {}
    for name, entry in machines.items():
        try:
            out[name] = build_machine(name, entry)
        except Exception as exc:
            # As a runtime entry's: the message must not quote a secret.
            masked = mask_values(str(exc), secrets.get(name, ()))
            if masked == str(exc):
                raise
            raise ValueError(masked) from None
    return out


def _cli_entry(name: str, block: CLIBlock) -> str | CLI:
    """Resolve one ``clis:`` entry to a spec key or synthesized spec.

    A ``cli`` entry stays the registered name for the workspace to
    resolve; a ``script`` entry becomes a single-node CLI carrying
    the embedded source, so the install is self-contained (the docker
    build-context model).

    Args:
        name (str): the section key, the installed head word.
        block (CLIBlock): the validated entry.
    """
    if block.script is not None:
        return CLI(
            spec=CommandSpec(name=name),
            script=_load_script_source(block.script),
            runtime=block.runtime,
        )
    if block.cli is None:
        raise ValueError(f"clis entry {name!r} takes cli or script")
    return block.cli


class WorkspaceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mounts: dict[str, MountBlock]
    io: IOConfig = Field(default_factory=IOConfig)
    command_limits: dict[str, Limit] | None = None
    # What the RAM mounts store and what a command builds may hold
    # together; null runs uncapped. Unset = the Workspace default.
    max_memory: str | int | None = None
    max_body_bytes: str | int | None = None
    # The bytes each session's variables, functions and aliases may hold:
    # a size, 2MB by default, null for no cap.
    max_env: str | int | None = None
    # Where the workspace's connections may go: true for anywhere, false
    # for nowhere, or {allow: [hosts and ranges]}.
    network: bool | dict[str, list[str] | dict[str, str]] = True
    # The workspace's time when it starts, an ISO 8601 instant with an
    # offset (2026-03-02T09:00:00Z); unset is the host's time.
    system_time: str | None = None
    # Installed CLIs, fully separate from mounts: key = installed head
    # word, value names a registered CLI plus its own config.
    clis: dict[str, CLIBlock] | None = None
    # The workspace's ordered runtime world: name strings or maps
    # with a name plus the uniform runtime options ({name: wasi,
    # config: {home: /opt/...}}). Unset = the default world.
    runtimes: list[str | dict[str, Any]] | None = None
    # Per runtime entry, the values `resolve_secrets` read into its
    # config, which a refusal of it masks.
    _runtime_secrets: tuple[tuple[str, ...], ...] = PrivateAttr(default=())
    # The machines programs run on, by name: each a provider plus how to
    # reach it ({provider: docker, container: tools}). A machine runtime
    # entry's `machine` names one. Unset = none.
    machines: dict[str, dict[str, Any]] | None = None
    # Per machine, the values `resolve_secrets` read into its entry,
    # which a refusal of it masks.
    _machine_secrets: dict[str, tuple[str, ...]] = PrivateAttr(
        default_factory=dict
    )
    # The route policy, a program the way a profile's policy names one:
    # {script: route.py, runtime: monty}. The script is embedded at load;
    # it prints {"kind": "route", "runtime": ...} to place a line, or
    # nothing to leave each command on its first capturer.
    route_policy: ProfilePolicy | None = None
    # The permission documents: one profile per name. A profile is the whole
    # document a session runs under, so there is no workspace-wide
    # block; route_policy is the one program every session shares.
    profiles: dict[str, SessionProfile] | None = None
    # The profile a session gets when it names none; `default` when unset
    # and a profile of that name exists.
    profile: str | None = None
    # The one workspace-wide block a profile overrides, field by field:
    # whose processes a session sees and stops, and how many it holds.
    processes: ProcessPermissions | None = None
    mode: MountMode = MountMode.WRITE
    # The read policy a mount inherits when it declares none. There is
    # deliberately no workspace-level bound: `ttl:` exists only inside a
    # mount block, where it cannot be confused with `index: {ttl:}`.
    read: ReadPolicy | None = None
    # The write policy a mount inherits when it declares none.
    write: WritePolicy | None = None
    default_session_id: str | None = None
    workspace_id: str | None = None
    cache: CacheBlock | None = None
    index: IndexBlock | None = None
    store: StoreBlock | None = None
    # The environment plane: one map, name -> entry. A bare string is
    # the literal short form; a mapping is an EnvVar, either a literal
    # with attrs or a managed pointer (`from`/`ref`/`key`/`fetch`).
    env: dict[str, str | EnvVar] | None = None
    # The source table: one map, instance name -> declaration, spelled
    # the way `mounts:` is. A managed env entry's `from` names an
    # instance here, or a source directly when the deployment has one
    # account of it and nothing to configure.
    secrets: dict[str, SecretSource] | None = None

    @field_validator("mode", mode="before")
    @classmethod
    def _v_mode(cls, v: Any) -> Any:
        return _coerce_mount_mode(v)

    @field_validator("read", mode="before")
    @classmethod
    def _v_read_default(cls, v: Any) -> ReadPolicy | None:
        if v is None:
            return v
        return coerce_read_policy(v)

    @field_validator("write", mode="before")
    @classmethod
    def _v_write_default(cls, v: Any) -> WritePolicy | None:
        if v is None:
            return v
        return coerce_write_policy(v)

    @field_validator("max_body_bytes", mode="before")
    @classmethod
    def _v_max_body_bytes(cls, v: Any) -> int | None:
        return v if v is None else parse_limit(v, "max_body_bytes")

    @field_validator("max_memory", mode="before")
    @classmethod
    def _v_max_memory(cls, v: Any) -> int | None:
        return v if v is None else parse_limit(v, "max_memory")

    @field_validator("max_env", mode="before")
    @classmethod
    def _v_max_env(cls, v: Any) -> int | None:
        return v if v is None else parse_limit(v, "max_env")

    @field_validator("network", mode="before")
    @classmethod
    def _v_network(cls, v: Any) -> NetworkSetting:
        layer = network_layer(v)
        NetworkRule(
            [layer] if layer is not None else [], False, network_routes(v)
        )
        return (
            bool(v)
            if isinstance(v, bool)
            else {
                key: dict(value) if key == "routes" else list(value)
                for key, value in v.items()
            }
        )

    @field_validator("system_time")
    @classmethod
    def _v_system_time(cls, v: str | None) -> str | None:
        if v is not None:
            parse_system_time(v)
        return v

    @model_validator(mode="after")
    def _v_profile(self) -> "WorkspaceConfig":
        # The workspace's default profile must be one it defines; the
        # loader's contract is a ValueError for a bad document.
        if self.profile is not None and self.profile not in (
            self.profiles or {}
        ):
            raise ValueError(f"unknown profile {self.profile!r}")
        return self

    def to_workspace_kwargs(
        self, mcp_clis: Mapping[str, CLI] | None = None
    ) -> dict[str, Any]:
        """Produce kwargs ready to splat into ``Workspace(**kwargs)``.

        Synchronous, and must stay that way: this is the YAML loader, and
        :func:`mirage.vfs.registry.build_vfs` behind it is the
        one every embedder calls. A backend needing I/O hydrates lazily
        instead of moving that cost into construction; see
        ``build_vfs`` for the full rule. Deliberately diverges from
        the TypeScript ``configToWorkspaceArgs``, which is async.

        Args:
            mcp_clis (Mapping[str, CLI] | None): the CLI each
                ``cli: mcp`` entry became, from :func:`build_mcp_clis`.

        Raises:
            ValueError: a ``cli: mcp`` entry has no built CLI.

        Returns:
            dict[str, Any]: VFS instances, cache config, and
                workspace-level settings, in the shape the
                ``Workspace`` constructor expects.
        """
        mounts: dict[str, Mount] = {}
        default_read = resolve_read_spec(self.read, None)
        for prefix, block in self.mounts.items():
            prov = build_vfs(block.vfs, block.config)
            mode = block.mode if block.mode is not None else self.mode
            read = (
                default_read
                if block.read is None
                else resolve_read_spec(block.read, block.ttl)
            )
            mounts[prefix] = Mount(
                vfs=prov,
                mode=mode,
                command_limits=block.command_limits,
                read=read,
                write=(
                    block.write
                    if block.write is not None
                    else coerce_write_policy(self.write)
                ),
                vfs_ref=block.vfs,
                index=(
                    _build_index_config(block.index)
                    if block.index is not None
                    else None
                ),
            )
        kwargs: dict[str, Any] = {
            "mounts": mounts,
            "io": self.io,
            "command_limits": self.command_limits,
            "mode": self.mode,
            "read": default_read,
            "write": self.write,
            "session_id": self.default_session_id,
        }
        kwargs["max_body_bytes"] = self.max_body_bytes
        if "max_memory" in self.model_fields_set:
            kwargs["max_memory"] = self.max_memory
        if "max_env" in self.model_fields_set:
            kwargs["max_env"] = self.max_env
        if "network" in self.model_fields_set:
            kwargs["network"] = self.network
        if self.system_time is not None:
            kwargs["system_time"] = self.system_time
        if self.cache is not None:
            kwargs["cache"] = _build_cache_config(self.cache)
        if self.index is not None:
            kwargs["index"] = _build_index_config(self.index)
        if self.workspace_id is not None:
            kwargs["workspace_id"] = self.workspace_id
        if self.store is not None:
            kwargs["store"] = _build_state_store(self.store)
            kwargs["owns_store"] = True
        if self.machines is not None:
            kwargs["machines"] = _build_machines(
                self.machines, self._machine_secrets
            )
        if self.runtimes is not None:
            kwargs["runtimes"] = _build_runtime_entries(
                self.runtimes, self._runtime_secrets
            )
        if self.route_policy is not None:
            kwargs["route_policy"] = _load_program(self.route_policy)
        if self.profiles is not None:
            kwargs["profiles"] = {
                name: _load_profile_policy(profile)
                for name, profile in self.profiles.items()
            }
        if self.profile is not None:
            kwargs["profile"] = self.profile
        if self.processes is not None:
            kwargs["processes"] = self.processes
        # Passed through as-is: this method is sync, and env-plane
        # resolution is async at command time, so no fetching here.
        if self.env is not None:
            kwargs["env"] = self.env
        # Same reason: building a source reads its bootstrap pointers,
        # which the workspace does once, before its first fetch.
        if self.secrets is not None:
            kwargs["secrets"] = self.secrets

        if self.clis is not None:
            built = mcp_clis or {}
            missing = [
                name
                for name, block in self.clis.items()
                if block.cli == MCP_CLI and name not in built
            ]
            if missing:
                raise ValueError(
                    f"clis entries {missing!r} are built from their MCP "
                    "server: pass mcp_clis=await build_mcp_clis(config)"
                )
            kwargs["clis"] = {
                name: (
                    built[name]
                    if block.cli == MCP_CLI
                    else _cli_entry(name, block),
                    dict(block.config),
                )
                for name, block in self.clis.items()
            }
        return kwargs

    def kernel_mounts(self) -> dict[str, tuple[MountBackend, str | None]]:
        """Declarative kernel mounts keyed by mount prefix.

        Mounts left on the default ``workspace`` backend are absent: they are
        served inside mirage's own filesystem and register nothing with the
        kernel.

        Returns:
            dict[str, tuple[MountBackend, str | None]]: prefix to
                (backend, mountpoint) for mounts that request one.
        """
        return {
            prefix: (block.backend, block.mountpoint)
            for prefix, block in self.mounts.items()
            if block.backend in KERNEL_BACKENDS
        }


def _build_cache_config(block: RamCacheBlock | RedisCacheBlock) -> CacheConfig:
    if isinstance(block, RedisCacheBlock):
        return RedisCacheConfig(
            limit=block.limit,
            max_drain_bytes=block.max_drain_bytes,
            url=block.url,
            key_prefix=block.key_prefix,
        )
    return CacheConfig(
        limit=block.limit,
        max_drain_bytes=block.max_drain_bytes,
    )


def _build_index_config(block: RamIndexBlock | RedisIndexBlock) -> IndexConfig:
    if isinstance(block, RedisIndexBlock):
        return RedisIndexConfig(
            ttl=block.ttl,
            url=block.url,
            key_prefix=block.key_prefix,
        )
    return IndexConfig(ttl=block.ttl)


def _redis_state_store() -> "type[_RedisStore]":
    store: type[_RedisStore] = optional_attr(
        "mirage.workspace.store.redis:RedisWorkspaceStateStore",
        "redis",
        "A redis store",
    )
    return store


def _build_store_group(
    block: RamStoreBlock | DiskStoreBlock | RedisStoreBlock | S3StoreBlock,
) -> WorkspaceStateStore:
    if isinstance(block, DiskStoreBlock):
        return DiskWorkspaceStateStore(root=block.root)
    if isinstance(block, RedisStoreBlock):
        return _redis_state_store()(url=block.url, key_prefix=block.key_prefix)
    if isinstance(block, S3StoreBlock):
        if S3WorkspaceStateStore is None:
            raise ImportError(
                "An s3 store requires the 's3' extra. "
                "Install with: pip install mirage-ai[s3]"
            )
        return S3WorkspaceStateStore(block)
    return RAMWorkspaceStateStore()


def _build_state_store(block: StoreBlock) -> WorkspaceStateStore:
    namespace = (
        _build_store_group(block.namespace)
        if block.namespace is not None
        else None
    )
    observer = (
        _build_store_group(block.observer)
        if block.observer is not None
        else None
    )
    workspace = (
        _build_store_group(block.workspace)
        if block.workspace is not None
        else None
    )
    execution = (
        _build_store_group(block.execution)
        if block.execution is not None
        else None
    )
    if block.type == "redis":
        return _redis_state_store()(
            url=block.url,
            key_prefix=block.key_prefix,
            root=block.root,
            namespace=namespace,
            observer=observer,
            workspace=workspace,
            execution=execution,
        )
    if block.type == "disk":
        return DiskWorkspaceStateStore(
            root=block.root,
            namespace=namespace,
            observer=observer,
            workspace=workspace,
            execution=execution,
        )
    return RAMWorkspaceStateStore(
        namespace=namespace,
        observer=observer,
        workspace=workspace,
        execution=execution,
    )


def _runtime_config(entry: str | dict[str, Any]) -> dict[str, Any] | None:
    """The config mapping of one ``runtimes:`` entry, if it has one.

    A name, or an entry whose config is not a mapping, has none: it is
    left as given for :func:`build_runtime` to build or refuse.

    Args:
        entry (str | dict[str, Any]): the entry as the config holds it.
    """
    if isinstance(entry, str):
        return None
    config = entry.get("config")
    return config if isinstance(config, dict) else None


async def resolve_secrets(config: "WorkspaceConfig") -> "WorkspaceConfig":
    """A config with every mount, CLI and runtime pointer replaced by its secret.

    The async half of the YAML loader, and the reason
    :meth:`WorkspaceConfig.to_workspace_kwargs` can stay sync: a
    `{from, ref, key}` in `mounts.*.config`, `clis.*.config`, a
    `runtimes` entry's `config` or a `machines` entry is fetched here, so
    `build_vfs`, `build_runtime` and `build_machine` receive the
    credential itself and no VFS config, runtime, machine, client or
    backend learns that this plane exists. Mirrors
    the TypeScript `configToWorkspaceArgs`, which does the same thing
    inline because it is async already.

    A `secrets:` block is not required: `fetch_secret` builds an
    undeclared builtin source from ambient defaults, so
    `{from: env, key: TOKEN}` resolves with no block at all and the
    walk runs either way. A config holding no pointer does no I/O.

    Args:
        config (WorkspaceConfig): the validated config.

    Returns:
        WorkspaceConfig: the same config, pointers resolved.

    Raises:
        SecretsError: a source could not answer, or answered without
            the wanted field.
    """
    runtimes = [_runtime_config(entry) for entry in config.runtimes or []]
    configs = [block.config for block in config.mounts.values()]
    configs += [block.config for block in (config.clis or {}).values()]
    configs += [c for c in runtimes if c is not None]
    configs += list((config.machines or {}).values())
    sources = await resolve_sources_for(config.secrets, configs)
    mounts = {
        prefix: block.model_copy(
            update={
                "config": await resolve_config_secrets(
                    block.config, sources, f"mounts.{prefix}.config"
                )
            }
        )
        for prefix, block in config.mounts.items()
    }
    update: dict[str, Any] = {"mounts": mounts}
    if config.clis is not None:
        update["clis"] = {
            name: block.model_copy(
                update={
                    "config": await resolve_config_secrets(
                        block.config, sources, f"clis.{name}.config"
                    )
                }
            )
            for name, block in config.clis.items()
        }
    secrets: list[tuple[str, ...]] = []
    if config.runtimes is not None:
        entries: list[str | dict[str, Any]] = []
        for entry, raw in zip(config.runtimes, runtimes, strict=True):
            if isinstance(entry, str) or raw is None:
                entries.append(entry)
                secrets.append(())
                continue
            read = await resolve_config_secrets(
                raw, sources, f"runtimes.{entry.get('name')}.config"
            )
            entries.append({**entry, "config": read})
            secrets.append(tuple(fetched_values(raw, read)))
        update["runtimes"] = entries
    held: dict[str, tuple[str, ...]] = {}
    if config.machines is not None:
        machines: dict[str, dict[str, Any]] = {}
        for name, raw in config.machines.items():
            read = await resolve_config_secrets(
                raw, sources, f"machines.{name}"
            )
            machines[name] = read
            held[name] = tuple(fetched_values(raw, read))
        update["machines"] = machines
    resolved = config.model_copy(update=update)
    if any(secrets):
        resolved._runtime_secrets = tuple(secrets)
    if any(held.values()):
        resolved._machine_secrets = held
    return resolved


async def build_mcp_clis(config: "WorkspaceConfig") -> dict[str, CLI]:
    """The CLI each ``cli: mcp`` entry becomes, read from its server.

    The second async step of the YAML loader, after
    :func:`resolve_secrets`: an MCP CLI's subcommands are the server's
    tools, so building one lists them over the network, held to the
    config's ``network`` and any rule already bound. Mirrors the
    TypeScript ``configToWorkspaceArgs``.

    Args:
        config (WorkspaceConfig): a config whose pointers are resolved.

    Raises:
        ValidationError: an entry's config is not an MCPConfig.
        MCPToolsError: a server could not be listed, its network refused
            it, or its tools cannot be made into a CLI.
    """
    blocks = {
        name: block
        for name, block in (config.clis or {}).items()
        if block.cli == MCP_CLI
    }
    if not blocks:
        return {}
    rule = narrowed(network_bound(), config.network)
    return {
        name: await run_with_network(rule, mcp.mcp_cli(block.config))
        for name, block in blocks.items()
    }


def load_config(
    source: str | Path | dict[str, Any], env: dict[str, str] | None = None
) -> WorkspaceConfig:
    """Load a workspace config from a YAML / JSON file or a raw dict.

    Performs ``${VAR}`` env interpolation before validation. If any
    referenced variable is missing, raises with the full list of
    missing names rather than failing lazily on first use.

    Args:
        source (str | Path | dict): path to a YAML / JSON file, or
            an already-parsed dict.
        env (dict[str, str] | None): environment mapping to read for
            interpolation. Defaults to ``os.environ``.

    Returns:
        WorkspaceConfig: validated config object.
    """
    base: Path | None = None
    if isinstance(source, (str, Path)):
        raw = parse_yaml(Path(source).read_text(encoding="utf-8"))
        base = Path(source).resolve().parent
    else:
        raw = dict(source)
    if not isinstance(raw, dict):
        raise ValueError(
            f"config source must be a mapping, got {type(raw).__name__}"
        )
    use_env = env if env is not None else dict(os.environ)
    interpolated = _interpolate_env(raw, use_env)
    if base is not None:
        _absolutize_scripts(interpolated, base)
    return WorkspaceConfig.model_validate(interpolated)


def load_policy_file(
    path: str | Path, env: dict[str, str] | None = None
) -> ProfileScripts:
    """Load a server's policy file: a profile's ``policy`` block, a
    mapping of method to programs, plus ``pre_workspace``, which a
    server asks before it builds a workspace. A relative ``script``
    path is read next to the file, after ``${VAR}`` interpolation.

    Args:
        path (str | Path): the YAML or JSON file.
        env (dict[str, str] | None): environment mapping to read for
            interpolation. Defaults to ``os.environ``.

    Raises:
        ValueError: the file is not a mapping of method to programs.
        FileNotFoundError: the file or a script it names is missing.
    """
    source = Path(path)
    raw = _interpolate_env(
        parse_yaml(source.read_text(encoding="utf-8")),
        env if env is not None else dict(os.environ),
    )
    methods = (*METHODS, "pre_workspace")
    if not isinstance(raw, dict):
        raise ValueError(
            f"{source}: a policy file is a mapping of method to programs"
        )
    unknown = sorted(str(key) for key in raw if key not in methods)
    if unknown:
        raise ValueError(
            f"{source}: names {', '.join(unknown)}; a program answers at "
            f"{', '.join(methods)}"
        )
    scripts: dict[str, tuple[ProfileScript, ...]] = {}
    for method, programs in raw.items():
        if not isinstance(programs, list):
            raise ValueError(f"{source}: {method} is a list of programs")
        loaded = []
        for program in programs:
            if isinstance(program, dict):
                _absolutize_script_key(program, source.resolve().parent)
            loaded.append(
                compile_program(
                    _load_program(ProfilePolicy.model_validate(program)),
                    source.name,
                )
            )
        scripts[method] = tuple(loaded)
    return scripts
