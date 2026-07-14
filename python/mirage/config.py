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

from mirage.cache.file.config import CacheConfig, RedisCacheConfig
from mirage.cache.index.config import IndexConfig, RedisIndexConfig
from mirage.resource.registry import build_resource
from mirage.runtime.python.select import (DEFAULT_PYTHON_RUNTIME,
                                          validate_python_runtime_name)
from mirage.types import CommandSafeguard, ConsistencyPolicy, MountMode


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

    def _sub(self, m: re.Match) -> str:
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


class RuntimeBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    python: str = DEFAULT_PYTHON_RUNTIME
    # Per-runtime option blocks, free key/values consumed by the
    # selected runtime; blocks for other runtimes (including the other
    # language's) are ignored, so one config stays portable. `home`
    # locates the interpreter or distribution: a CPython WASI build
    # directory for `wasi` (falls back to MIRAGE_WASI_HOME), an
    # interpreter path for `local` (falls back to MIRAGE_LOCAL_HOME),
    # a distribution URL for `pyodide` (TypeScript).
    monty: dict[str, Any] | None = None
    wasi: dict[str, Any] | None = None
    local: dict[str, Any] | None = None
    pyodide: dict[str, Any] | None = None

    @field_validator("python")
    @classmethod
    def _v_python(cls, v):
        return validate_python_runtime_name(v)

    def option_blocks(self) -> dict[str, dict[str, Any]]:
        """Collect the declared per-runtime option blocks.

        Returns:
            dict[str, dict[str, Any]]: runtime name to option block,
                omitting runtimes without one.
        """
        blocks = {
            "monty": self.monty,
            "wasi": self.wasi,
            "local": self.local,
            "pyodide": self.pyodide,
        }
        return {k: v for k, v in blocks.items() if v is not None}


class WorkspaceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mounts: dict[str, MountBlock]
    runtime: RuntimeBlock | None = None
    mode: MountMode = MountMode.WRITE
    consistency: ConsistencyPolicy = ConsistencyPolicy.LAZY
    default_session_id: str = "default"
    default_agent_id: str = "default"
    cache: CacheBlock | None = None
    index: IndexBlock | None = None

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
        resources: dict[str, Any] = {}
        for prefix, block in self.mounts.items():
            prov = build_resource(block.resource, block.config)
            mode = block.mode if block.mode is not None else self.mode
            if block.command_safeguards:
                resources[prefix] = (prov, mode, block.command_safeguards)
            else:
                resources[prefix] = (prov, mode)
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
        if self.runtime is not None:
            kwargs["python_runtime"] = self.runtime.python
            blocks = self.runtime.option_blocks()
            if blocks:
                kwargs["runtime_options"] = blocks
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


def load_config(source: str | Path | dict,
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
