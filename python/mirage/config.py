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
from pydantic import BaseModel, ConfigDict, Field, field_validator

from mirage.accessor.s3 import S3Config
from mirage.cache.file.config import CacheConfig, RedisCacheConfig
from mirage.cache.index.config import IndexConfig, RedisIndexConfig
from mirage.resource.registry import build_resource
from mirage.runtime.base import Runtime
from mirage.runtime.table import VFS_ENTRY, build_runtime
from mirage.types import CommandSafeguard, ConsistencyPolicy, MountMode
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


class MountBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    resource: str
    mode: MountMode | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    command_safeguards: dict[str,
                             CommandSafeguard] = Field(default_factory=dict)
    fuse: bool | str = False

    @field_validator("mode", mode="before")
    @classmethod
    def _v_mode(cls, v):
        if v is None:
            return v
        return _coerce_mount_mode(v)


def _build_runtime_entries(
        entries: list[str | dict[str, Any]]) -> list["Runtime | str"]:
    """Turn config runtime entries into workspace runtime entries.

    Args:
        entries (list[str | dict[str, Any]]): name strings, or maps
            carrying a name plus constructor options flat on the entry.

    Raises:
        ValueError: a map entry without a name, or options on vfs.
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
        if name == VFS_ENTRY:
            if options:
                raise ValueError("the vfs runtime entry takes no options")
            out.append(VFS_ENTRY)
            continue
        out.append(build_runtime(name, **options))
    return out


class WorkspaceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mounts: dict[str, MountBlock]
    # The workspace's ordered runtime world: name strings or maps
    # with a name plus constructor options flat on the entry
    # ({name: wasi, home: /opt/...}). Unset = the default world.
    runtimes: list[str | dict[str, Any]] | None = None
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

    def to_workspace_kwargs(self) -> dict[str, Any]:
        """Produce kwargs ready to splat into ``Workspace(**kwargs)``.

        Returns:
            dict[str, Any]: resource instances, cache config, and
                workspace-level settings, in the shape the
                ``Workspace`` constructor expects.
        """
        resources: dict[str, Mount] = {}
        for prefix, block in self.mounts.items():
            prov = build_resource(block.resource, block.config)
            mode = block.mode if block.mode is not None else self.mode
            resources[prefix] = Mount(
                resource=prov,
                mode=mode,
                command_safeguards=block.command_safeguards,
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
        return kwargs

    def fuse_mounts(self) -> dict[str, bool | str]:
        """Declarative FUSE mounts keyed by mount prefix.

        Returns:
            dict[str, bool | str]: prefix to ``fuse`` block value (a
                mountpoint path or ``True``) for mounts that request FUSE.
        """
        return {
            prefix: block.fuse
            for prefix, block in self.mounts.items() if block.fuse
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
    if isinstance(source, (str, Path)):
        text = Path(source).read_text(encoding="utf-8")
        raw = yaml.safe_load(text)
    else:
        raw = dict(source)
    if not isinstance(raw, dict):
        raise ValueError(
            f"config source must be a mapping, got {type(raw).__name__}")
    use_env = env if env is not None else dict(os.environ)
    interpolated = _interpolate_env(raw, use_env)
    return WorkspaceConfig.model_validate(interpolated)
