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
from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import (BaseModel, ConfigDict, Field, field_validator,
                      model_validator)

from mirage.accessor.s3 import S3Config
from mirage.cache.file.config import CacheConfig, RedisCacheConfig
from mirage.cache.index.config import IndexConfig, RedisIndexConfig
from mirage.commands.cli.types import CLISpec
from mirage.policy import GuardSpec
from mirage.resource.registry import build_resource
from mirage.runtime.base import Runtime
from mirage.runtime.table import build_runtime
from mirage.runtime.types import Language, ScriptSource
from mirage.types import (KERNEL_BACKENDS, ConsistencyPolicy, Limit,
                          MountBackend, MountMode)
from mirage.workspace.mount.spec import Mount
from mirage.workspace.store import (DEFAULT_STATE_ROOT,
                                    DiskWorkspaceStateStore,
                                    RAMWorkspaceStateStore,
                                    WorkspaceStateStore)

try:
    from mirage.workspace.store import RedisWorkspaceStateStore
except ImportError:
    RedisWorkspaceStateStore = None

try:
    from mirage.workspace.store import S3WorkspaceStateStore
except ImportError:
    S3WorkspaceStateStore = None


def _coerce_mount_mode(value):
    if isinstance(value, MountMode):
        return value
    if isinstance(value, str):
        return MountMode(value.lower())
    return value


def _coerce_consistency(value):
    if isinstance(value, ConsistencyPolicy):
        return value
    if isinstance(value, str):
        return ConsistencyPolicy(value.lower())
    return value


_VAR_RE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}")


class _EnvInterpolator:

    def __init__(self, env: dict[str, str], missing: list[str]) -> None:
        self.env = env
        self.missing = missing

    def _sub(self, m: re.Match[str]) -> str:
        name = m.group(1)
        if name not in self.env:
            self.missing.append(name)
            return ""
        return self.env[name]

    def apply(self, value: Any) -> Any:
        if isinstance(value, str):
            return _VAR_RE.sub(self._sub, value)
        if isinstance(value, dict):
            return {k: self.apply(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self.apply(v) for v in value]
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
    interp = _EnvInterpolator(env, missing)
    out = interp.apply(value)
    if missing:
        unique_missing = sorted(set(missing))
        raise ValueError(f"missing environment variables: {unique_missing}")
    return out


class RamCacheBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["ram"] = "ram"
    limit: str | int = "512MB"
    max_drain_bytes: int | None = None


class RedisCacheBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["redis"]
    limit: str | int = "512MB"
    max_drain_bytes: int | None = None
    url: str = "redis://localhost:6379/0"
    key_prefix: str = "mirage:cache:"


CacheBlock = Annotated[
    RamCacheBlock | RedisCacheBlock,
    Field(discriminator="type"),
]


class RamIndexBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["ram"] = "ram"
    ttl: float = 600


class RedisIndexBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["redis"]
    ttl: float = 600
    url: str = "redis://localhost:6379/0"
    key_prefix: str = "mirage:index:"


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
    """The workspace state store: one block, four planes.

    The top-level type/url/key_prefix pick the default backend for
    every control-plane group (namespace nodes, observer events,
    sessions + workspace metadata). The optional per-group overrides
    redirect one group to a different backend, e.g. large observer
    logs to a separate server. Sessions and workspace metadata move
    together by design (the default-session pointer must live beside
    the session table it points into), so there is one `workspace`
    override, not two. An ``s3`` group hosts only the sessions+meta
    group (conditional-PUT CAS), so it is valid as the ``workspace``
    override, never as the top-level default. A ``disk`` store hosts
    all planes under ``root`` (lockfile CAS, machine-local); ``root``
    is only read when a disk store is selected.
    """

    model_config = ConfigDict(extra="forbid")

    type: Literal["ram", "disk", "redis"] = "ram"
    url: str = "redis://localhost:6379/0"
    key_prefix: str = "mirage:"
    root: str = DEFAULT_STATE_ROOT
    namespace: StoreGroupBlock | None = None
    observer: StoreGroupBlock | None = None
    workspace: StoreGroupBlock | None = None


class GuardBlock(BaseModel):
    """One declarative command guard (the yaml ``guards:`` entries).

    Compiled to a GuardSpec: refuse the named commands (all commands
    when empty) whenever an operand matches one of the ``*``/``?``
    path patterns (regardless of operands when empty).
    """

    model_config = ConfigDict(extra="forbid")

    reason: str
    commands: list[str] = Field(default_factory=list)
    paths: list[str] = Field(default_factory=list)


class CLIBlock(BaseModel):
    """One ``clis:`` entry: install a named CLISpec with its own config.

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
                "runtime pins the script's runtime; it takes script")
        return self


class MountBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    resource: str
    mode: MountMode | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    command_limits: dict[str, Limit] = Field(default_factory=dict)
    # How the mount is exposed: vfs (default, mirage's own filesystem only),
    # fuse, or fskit. mountpoint is honored by the kernel backends.
    backend: MountBackend = MountBackend.VFS
    mountpoint: str | None = None

    @field_validator("mode", mode="before")
    @classmethod
    def _v_mode(cls, v):
        if v is None:
            return v
        return _coerce_mount_mode(v)


def _is_script_path(value: str) -> bool:
    """True for the docker-style single-line script path form.

    ``.py`` runs on a python evaluator (monty), ``.js``/``.mjs`` on a
    JS one (quickjs); the script's language must match the world's
    policy engine.

    Args:
        value (str): a yaml ``script``/``policy`` value.
    """
    return "\n" not in value and value.strip().endswith((".py", ".js", ".mjs"))


def _load_script_source(value: str) -> ScriptSource:
    """Embed the referenced script file as source.

    Config carries a reference, the wire carries content (the docker
    build-context model): the value must be a path to a ``.py`` file,
    read at load time. In code, scripts are callables; config is the
    only door for script source.

    Args:
        value (str): the yaml ``script``/``policy`` value.

    Raises:
        ValueError: the value is not a script path.
        FileNotFoundError: the referenced file does not exist.
    """
    if not _is_script_path(value):
        raise ValueError("a config script must reference a .py/.js file "
                         f"(e.g. script: guard.py), got {value!r}")
    path = Path(value.strip())
    language: Language = ("js" if path.suffix in (".js", ".mjs") else "python")
    return ScriptSource(path.read_text(),
                        language=language,
                        module=path.suffix == ".mjs")


def _absolutize_scripts(raw: dict[str, Any], base: Path) -> None:
    """Resolve relative script paths against the config file's dir.

    A path-form ``script``/``policy`` in a config file means "next to
    the file" (the docker build-context model), never "wherever the
    server happens to run". Mutates the parsed mapping in place;
    in-memory dict configs are untouched by the loader.

    Args:
        raw (dict[str, Any]): the parsed config mapping.
        base (Path): directory containing the config file.
    """
    policy = raw.get("policy")
    if isinstance(policy, str) and _is_script_path(policy) \
            and not Path(policy.strip()).is_absolute():
        raw["policy"] = str(base / policy.strip())
    runtimes = raw.get("runtimes")
    if isinstance(runtimes, list):
        for entry in runtimes:
            if isinstance(entry, dict):
                _absolutize_script_key(entry, base)
    clis = raw.get("clis")
    if isinstance(clis, dict):
        for block in clis.values():
            if isinstance(block, dict):
                _absolutize_script_key(block, base)
                _absolutize_cli_ref(block, base)


def _absolutize_script_key(entry: dict[str, Any], base: Path) -> None:
    """Rebase one mapping's relative ``script`` path onto ``base``.

    Args:
        entry (dict[str, Any]): a ``runtimes`` or ``clis`` mapping
            entry, mutated in place.
        base (Path): directory containing the config file.
    """
    script = entry.get("script")
    if isinstance(script, str) and _is_script_path(script) \
            and not Path(script.strip()).is_absolute():
        entry["script"] = str(base / script.strip())


def _absolutize_cli_ref(entry: dict[str, Any], base: Path) -> None:
    """Rebase one ``clis`` entry's path-form ``cli`` reference.

    ``cli: ./tool.py:TREE`` means "next to the config file", the same
    build-context rule ``script:`` follows; without this the pointer
    reaches ``load_attr`` relative and resolves against the server
    process's cwd. A module dotpath (``pkg.mod:TREE``) is left alone:
    importlib resolves it, not the filesystem. The split matches
    ``load_attr``'s own test, so the two cannot disagree about what a
    path is.

    Args:
        entry (dict[str, Any]): a ``clis`` mapping entry, mutated in
            place.
        base (Path): directory containing the config file.
    """
    ref = entry.get("cli")
    if not isinstance(ref, str) or ":" not in ref:
        return
    source, attr = ref.rsplit(":", 1)
    if "/" not in source and not source.endswith(".py"):
        return
    if Path(source).is_absolute():
        return
    entry["cli"] = f"{base / source}:{attr}"


def _build_runtime_entries(
        entries: list[str | dict[str, Any]]) -> list["Runtime | str"]:
    """Turn config runtime entries into workspace runtime entries.

    Args:
        entries (list[str | dict[str, Any]]): name strings, or maps
            carrying a name plus the uniform runtime options
            (``captures``, ``config``, ``script``).

    Raises:
        ValueError: a map entry without a name, or a non-path script.
    """
    out: list[Runtime | str] = []
    for entry in entries:
        if isinstance(entry, str):
            out.append(entry)
            continue
        options = dict(entry)
        name = options.pop("name", None)
        if not isinstance(name, str) or not name:
            raise ValueError("runtime entry needs a non-empty 'name'")
        script = options.pop("script", None)
        if script is not None and not isinstance(script, str):
            raise ValueError(
                "a runtime entry script must be a .py path string")
        if script is not None:
            options["script"] = _load_script_source(script)
        out.append(build_runtime(name, **options))
    return out


def _cli_entry(name: str, block: CLIBlock) -> str | CLISpec:
    """Resolve one ``clis:`` entry to a spec key or synthesized spec.

    A ``cli`` entry stays the registered name for the workspace to
    resolve; a ``script`` entry becomes a single-node CLISpec carrying
    the embedded source, so the install is self-contained (the docker
    build-context model).

    Args:
        name (str): the section key, the installed head word.
        block (CLIBlock): the validated entry.
    """
    if block.script is not None:
        return CLISpec(name=name,
                       script=_load_script_source(block.script),
                       runtime=block.runtime)
    if block.cli is None:
        raise ValueError(f"clis entry {name!r} takes cli or script")
    return block.cli


class WorkspaceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mounts: dict[str, MountBlock]
    # Installed CLIs, fully separate from mounts: key = installed head
    # word, value names a registered CLISpec plus its own config.
    clis: dict[str, CLIBlock] | None = None
    # The workspace's ordered runtime world: name strings or maps
    # with a name plus the uniform runtime options ({name: wasi,
    # config: {home: /opt/...}}). Unset = the default world.
    runtimes: list[str | dict[str, Any]] | None = None
    # Global policy script: a .py path whose content is embedded at
    # load. Its last expression names the runtime for the line, or
    # None to fall to entry scripts.
    policy: str | None = None
    # Declarative command guards, checked after the built-in POSIX
    # mount-root rules; the policy script is the line-level
    # counterpart.
    guards: list[GuardBlock] | None = None
    mode: MountMode = MountMode.WRITE
    consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY
    default_session_id: str | None = None
    default_agent_id: str | None = None
    workspace_id: str | None = None
    cache: CacheBlock | None = None
    index: IndexBlock | None = None
    store: StoreBlock | None = None

    @field_validator("mode", mode="before")
    @classmethod
    def _v_mode(cls, v):
        return _coerce_mount_mode(v)

    @field_validator("consistency", mode="before")
    @classmethod
    def _v_cons(cls, v):
        return _coerce_consistency(v)

    async def to_workspace_kwargs(self) -> dict[str, Any]:
        """Produce kwargs ready to splat into ``Workspace(**kwargs)``.

        Async because building a mount's resource can be: a backend
        whose setup needs I/O does it in ``BaseResource.create``. Only
        the resources are awaited — ``Workspace(**kwargs)`` itself stays
        synchronous. Mirrors the TypeScript ``configToWorkspaceArgs``.

        Returns:
            dict[str, Any]: resource instances, cache config, and
                workspace-level settings, in the shape the
                ``Workspace`` constructor expects.
        """
        resources: dict[str, Mount] = {}
        for prefix, block in self.mounts.items():
            prov = await build_resource(block.resource, block.config)
            mode = block.mode if block.mode is not None else self.mode
            resources[prefix] = Mount(
                resource=prov,
                mode=mode,
                command_limits=block.command_limits,
            )
        kwargs: dict[str, Any] = {
            "resources": resources,
            "mode": self.mode,
            "consistency": self.consistency,
            "session_id": self.default_session_id,
            "agent_id": self.default_agent_id,
        }
        if self.cache is not None:
            kwargs["cache"] = _build_cache_config(self.cache)
        if self.index is not None:
            kwargs["index"] = _build_index_config(self.index)
        if self.workspace_id is not None:
            kwargs["workspace_id"] = self.workspace_id
        if self.store is not None:
            kwargs["store"] = _build_state_store(self.store)
            kwargs["owns_store"] = True
        if self.runtimes is not None:
            kwargs["runtimes"] = _build_runtime_entries(self.runtimes)
        if self.policy is not None:
            kwargs["policy"] = _load_script_source(self.policy)
        if self.guards is not None:
            kwargs["guards"] = [
                GuardSpec(reason=g.reason,
                          commands=tuple(g.commands),
                          paths=tuple(g.paths)) for g in self.guards
            ]

        if self.clis is not None:
            kwargs["clis"] = {
                name: (_cli_entry(name, block), dict(block.config))
                for name, block in self.clis.items()
            }
        return kwargs

    def kernel_mounts(self) -> dict[str, tuple[MountBackend, str | None]]:
        """Declarative kernel mounts keyed by mount prefix.

        Mounts left on the default ``vfs`` backend are absent: they are
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


def _build_store_group(
    block: RamStoreBlock | DiskStoreBlock | RedisStoreBlock | S3StoreBlock
) -> WorkspaceStateStore:
    if isinstance(block, DiskStoreBlock):
        return DiskWorkspaceStateStore(root=block.root)
    if isinstance(block, RedisStoreBlock):
        if RedisWorkspaceStateStore is None:
            raise ImportError("A redis store requires the 'redis' extra. "
                              "Install with: pip install mirage-ai[redis]")
        return RedisWorkspaceStateStore(url=block.url,
                                        key_prefix=block.key_prefix)
    if isinstance(block, S3StoreBlock):
        if S3WorkspaceStateStore is None:
            raise ImportError("An s3 store requires the 's3' extra. "
                              "Install with: pip install mirage-ai[s3]")
        return S3WorkspaceStateStore(block)
    return RAMWorkspaceStateStore()


def _build_state_store(block: StoreBlock) -> WorkspaceStateStore:
    namespace = _build_store_group(
        block.namespace) if block.namespace is not None else None
    observer = _build_store_group(
        block.observer) if block.observer is not None else None
    workspace = _build_store_group(
        block.workspace) if block.workspace is not None else None
    if block.type == "redis":
        if RedisWorkspaceStateStore is None:
            raise ImportError("A redis store requires the 'redis' extra. "
                              "Install with: pip install mirage-ai[redis]")
        return RedisWorkspaceStateStore(url=block.url,
                                        key_prefix=block.key_prefix,
                                        namespace=namespace,
                                        observer=observer,
                                        workspace=workspace)
    if block.type == "disk":
        return DiskWorkspaceStateStore(root=block.root,
                                       namespace=namespace,
                                       observer=observer,
                                       workspace=workspace)
    return RAMWorkspaceStateStore(namespace=namespace,
                                  observer=observer,
                                  workspace=workspace)


def load_config(source: str | Path | dict[str, Any],
                env: dict[str, str] | None = None) -> WorkspaceConfig:
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
        text = Path(source).read_text(encoding="utf-8")
        raw = yaml.safe_load(text)
        base = Path(source).resolve().parent
    else:
        raw = dict(source)
    if not isinstance(raw, dict):
        raise ValueError(
            f"config source must be a mapping, got {type(raw).__name__}")
    use_env = env if env is not None else dict(os.environ)
    interpolated = _interpolate_env(raw, use_env)
    if base is not None:
        _absolutize_scripts(interpolated, base)
    return WorkspaceConfig.model_validate(interpolated)
