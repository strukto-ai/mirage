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

import logging
from collections.abc import Callable, Iterator, Mapping
from contextvars import ContextVar
from typing import Any
from urllib.parse import parse_qs, urlsplit

from pydantic import BaseModel, ConfigDict

from mirage.agents.hermes.constants import (
    AMBIENT_MACHINES,
    AMBIENT_VFS,
    AWS_MECHANISM,
    KEYED_MACHINES,
    LOCAL_SCHEMES,
    MONGO_VFS,
    OAUTH_CLIS,
    OAUTH_VFS,
    OUTSIDE,
    REFRESH_FIELDS,
    ROUTED_SOURCES,
    SOURCE,
)
from mirage.commands.cli.mcp.constants import NAME as MCP_CLI
from mirage.commands.cli.specs import BUILTIN_CLI_SPECS
from mirage.config import S3StoreBlock, WorkspaceConfig
from mirage.secrets.config import EnvVar
from mirage.secrets.errors import SecretsError
from mirage.secrets.sources import is_config_pointer
from mirage.secrets.types import ResolvedSecret
from mirage.vfs.registry import REGISTRY, resolve_class, resolve_entry

logger = logging.getLogger(__name__)

BUILTIN_CLIS = frozenset({*BUILTIN_CLI_SPECS, MCP_CLI})

SCOPE: ContextVar[Mapping[str, str] | None] = ContextVar(
    "mirage_hermes_secrets", default=None
)


class HermesSourceConfig(BaseModel):
    """The ``hermes`` secret source's config: there is nothing to say;
    the values are the active hermes profile's."""

    model_config = ConfigDict(frozen=True, extra="forbid")


async def fetch_hermes(config: HermesSourceConfig, ref: str) -> ResolvedSecret:
    """Read the values hermes gave the running task.

    hermes scopes a secret to its active profile through a context
    variable of the thread that asks, so the provider reads every name
    the YAML uses on hermes' own thread and the task carries that
    snapshot here in ``SCOPE``.

    Args:
        config (HermesSourceConfig): carries nothing.
        ref (str): must be empty; a pointer's ``key`` names the value.

    Raises:
        SecretsError: a non-empty ``ref``, or no hermes task is running.
    """
    if ref:
        raise SecretsError(f"the {SOURCE!r} source takes no ref, got {ref!r}")
    scope = SCOPE.get()
    if scope is None:
        raise SecretsError(
            f"the {SOURCE!r} source answers only inside a hermes task"
        )
    return ResolvedSecret(fields=dict(scope))


class HermesSecrets(dict[str, str]):
    """The values a workspace YAML names, read from hermes on first use.

    ``load_config`` interpolates ``${NAME}`` against this mapping, so
    each name the YAML uses is asked of hermes once, on the thread that
    holds hermes' profile scope, and nothing reads ``os.environ``.

    Args:
        get_secret (Callable[[str], str | None]): hermes'
            ``agent.secret_scope.get_secret``.
    """

    def __init__(self, get_secret: Callable[[str], str | None]) -> None:
        super().__init__()
        self._get_secret = get_secret
        self.missing: set[str] = set()

    def __contains__(self, name: Any) -> bool:
        if not isinstance(name, str):
            return False
        if dict.__contains__(self, name):
            return True
        value = self._get_secret(name)
        if value is None:
            self.missing.add(name)
            return False
        self[name] = value
        return True


def _pointers(value: Any) -> Iterator[dict[str, Any]]:
    if is_config_pointer(value):
        yield value
    elif isinstance(value, Mapping):
        for child in value.values():
            yield from _pointers(child)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _pointers(item)


def _rewrite(value: Any, swap: Callable[[dict[str, Any]], Any]) -> Any:
    if is_config_pointer(value):
        return swap(value)
    if isinstance(value, Mapping):
        return {key: _rewrite(child, swap) for key, child in value.items()}
    if isinstance(value, list):
        return [_rewrite(item, swap) for item in value]
    if isinstance(value, tuple):
        return tuple(_rewrite(item, swap) for item in value)
    return value


def _routed(pointer: dict[str, Any]) -> dict[str, Any]:
    return {**pointer, "from": SOURCE}


def _rewritten(
    config: WorkspaceConfig, swap: Callable[[dict[str, Any]], Any]
) -> dict[str, Any]:
    update: dict[str, Any] = {
        "mounts": {
            prefix: block.model_copy(
                update={"config": _rewrite(block.config, swap)}
            )
            for prefix, block in config.mounts.items()
        }
    }
    if config.clis is not None:
        update["clis"] = {
            name: cli.model_copy(update={"config": _rewrite(cli.config, swap)})
            for name, cli in config.clis.items()
        }
    if config.machines is not None:
        update["machines"] = {
            name: _rewrite(machine, swap)
            for name, machine in config.machines.items()
        }
    return update


def _refused(refusals: list[str]) -> ValueError:
    return ValueError(
        "the mirage backend takes keys only from Hermes. Put each key "
        "in this Hermes profile (`hermes config set NAME value`) and "
        "write it as ${NAME} in the workspace YAML:\n  "
        + "\n  ".join(refusals)
    )


def _config_refusals(label: str, config: Mapping[str, Any]) -> list[str]:
    return [
        f"{label}: `from: {pointer['from']}` reads a key around Hermes"
        for pointer in _pointers(config)
        if pointer["from"] not in ROUTED_SOURCES
    ]


def _holds_from(value: Any) -> bool:
    if isinstance(value, Mapping):
        if isinstance(value.get("from"), str):
            return True
        return any(_holds_from(child) for child in value.values())
    if isinstance(value, (list, tuple)):
        return any(_holds_from(item) for item in value)
    return False


def _env_block(
    label: str, env: Mapping[str, str | EnvVar] | None
) -> tuple[list[str], dict[str, EnvVar]]:
    refusals: list[str] = []
    routed: dict[str, EnvVar] = {}
    for name, entry in (env or {}).items():
        if isinstance(entry, str) or entry.provider is None:
            continue
        if entry.provider not in ROUTED_SOURCES:
            refusals.append(
                f"{label}.{name}: `from: {entry.provider}` reads a key "
                "around Hermes"
            )
        routed[name] = entry.model_copy(update={"provider": SOURCE})
    return refusals, routed


def through_hermes(
    config: WorkspaceConfig, secrets: HermesSecrets
) -> WorkspaceConfig:
    """The config with every key it names read through hermes.

    Each ``{from: env, key: NAME}`` pointer, in a mount, CLI or machine
    config or an ``env:`` block (the workspace's or a session profile's),
    is routed to the ``hermes`` source and
    its name read from ``secrets``. A config that would reach a key some
    other way is refused whole, naming every place that does.

    Args:
        config (WorkspaceConfig): the config ``load_config`` returned
            with ``secrets`` as its environment.
        secrets (HermesSecrets): the names read from hermes so far.

    Raises:
        ValueError: the config reads a key around hermes, or names one
            the active hermes profile does not hold.
    """
    refusals: list[str] = []
    if config.secrets:
        refusals.append(
            "secrets: declares key sources Hermes does not route; "
            "remove the block"
        )
    for prefix, block in config.mounts.items():
        refusals += _config_refusals(f"mounts.{prefix}", block.config)
    for name, cli in (config.clis or {}).items():
        refusals += _config_refusals(f"clis.{name}", cli.config)
    for name, machine in (config.machines or {}).items():
        refusals += _config_refusals(f"machines.{name}", machine)
    refused, env = _env_block("env", config.env)
    refusals += refused
    profiles: dict[str, dict[str, EnvVar]] = {}
    for name, profile in (config.profiles or {}).items():
        refused, profiles[name] = _env_block(
            f"profiles.{name}.env", profile.env
        )
        refusals += refused
        programs = [
            program.model_dump(by_alias=True)
            for listed in (profile.policy or {}).values()
            for program in listed
        ]
        if _holds_from(programs):
            refusals.append(
                f"profiles.{name}.policy: a program's env pointer reads "
                "around Hermes; write ${NAME} instead"
            )
    if config.route_policy is not None and _holds_from(
        config.route_policy.model_dump(by_alias=True)
    ):
        refusals.append(
            "route_policy: a program's env pointer reads around Hermes; "
            "write ${NAME} instead"
        )
    if refusals:
        raise _refused(refusals)
    configs = [block.config for block in config.mounts.values()]
    configs += [cli.config for cli in (config.clis or {}).values()]
    configs += list((config.machines or {}).values())
    keys = [pointer["key"] for one in configs for pointer in _pointers(one)]
    for entries in (env, *profiles.values()):
        keys += [entry.key or name for name, entry in entries.items()]
    missing = {key for key in keys if key not in secrets}
    if missing:
        raise missing_error(missing)

    def filled(pointer: dict[str, Any]) -> str:
        return secrets[pointer["key"]]

    # Judged with each key in place, so a dsn read through a pointer counts.
    refusals = ambient_refusals(
        config.model_copy(update=_rewritten(config, filled))
    )
    if refusals:
        raise _refused(refusals)
    update = _rewritten(config, _routed)
    if env:
        update["env"] = {**(config.env or {}), **env}
    if config.profiles:
        update["profiles"] = {
            name: profile.model_copy(
                update={"env": {**(profile.env or {}), **profiles[name]}}
            )
            if profiles[name]
            else profile
            for name, profile in config.profiles.items()
        }
    return config.model_copy(update=update)


def _s3_shaped(vfs: str) -> bool:
    entry = resolve_entry(vfs)
    if entry is None or entry.config_path is None:
        return False
    try:
        model = resolve_class(entry.config_path)
    except ImportError as exc:
        # Its extra is not installed, so the mount cannot be built at all.
        logger.debug("%s config not importable: %r", vfs, exc)
        return False
    return "aws_profile" in getattr(model, "model_fields", {})


def _s3_refusal(label: str, config: Mapping[str, Any]) -> str | None:
    if config.get("aws_profile"):
        return f"{label}: `aws_profile` reads ~/.aws"
    pairs = (
        ("aws_access_key_id", "aws_secret_access_key"),
        ("access_key_id", "secret_access_key"),
    )
    if not any(config.get(a) and config.get(b) for a, b in pairs):
        return f"{label}: an S3 store with no key pair reads ~/.aws"
    return None


def _mount_refusal(prefix: str, vfs: str, config: Mapping[str, Any]) -> str:
    label = f"mounts.{prefix} ({vfs})"
    if vfs not in REGISTRY:
        return f"{label}: {OUTSIDE}"
    if vfs in AMBIENT_VFS:
        return f"{label}: {AMBIENT_VFS[vfs]}"
    if config.get("aws_profile"):
        return f"{label}: `aws_profile` reads ~/.aws"
    if vfs in OAUTH_VFS and any(config.get(f) for f in REFRESH_FIELDS):
        return f"{label}: Mirage would refresh the OAuth token itself"
    if vfs == "postgres":
        dsn = urlsplit(str(config.get("dsn", "")))
        if dsn.password is None and "password" not in parse_qs(dsn.query):
            return (
                f"{label}: a dsn with no password reads PGPASSWORD "
                "or ~/.pgpass"
            )
    if vfs in MONGO_VFS:
        uri = urlsplit(str(config.get("uri", "")))
        if AWS_MECHANISM in uri.query.upper() and uri.password is None:
            return f"{label}: MONGODB-AWS with no key reads ~/.aws"
    if vfs == "lancedb":
        scheme = urlsplit(str(config.get("uri", ""))).scheme
        if scheme == "db" and not config.get("api_key"):
            return (
                f"{label}: a db:// uri with no api_key reads LANCEDB_API_KEY"
            )
        if scheme not in LOCAL_SCHEMES and not config.get("storage_options"):
            return (
                f"{label}: a {scheme}:// uri with no storage_options "
                "reads the cloud's own login"
            )
    if _s3_shaped(vfs):
        return _s3_refusal(label, config) or ""
    return ""


def _machine_refusal(name: str, machine: Mapping[str, Any]) -> str:
    provider = str(machine.get("provider", ""))
    label = f"machines.{name} ({provider})"
    if provider in AMBIENT_MACHINES:
        return f"{label}: {AMBIENT_MACHINES[provider]}"
    if ":" in str(machine.get("runtime", "")):
        return f"{label}: {OUTSIDE}"
    if provider in KEYED_MACHINES and not machine.get("api_key"):
        return (
            f"{label}: no api_key, so its SDK reads one from the environment"
        )
    return ""


def ambient_refusals(config: WorkspaceConfig) -> list[str]:
    """Where the config would reach a key Hermes did not hand over: a
    host login, a vendor SDK's default chain, or an OAuth refresh.

    Args:
        config (WorkspaceConfig): the loaded config.
    """
    found = [
        _mount_refusal(prefix, block.vfs, block.config)
        for prefix, block in config.mounts.items()
    ]
    found += [
        _machine_refusal(name, machine)
        for name, machine in (config.machines or {}).items()
    ]
    for name, cli in (config.clis or {}).items():
        named = cli.cli is not None and cli.cli not in BUILTIN_CLIS
        if named or ":" in str(cli.runtime or ""):
            found.append(f"clis.{name} ({cli.cli or cli.runtime}): {OUTSIDE}")
        elif cli.cli in OAUTH_CLIS and any(
            cli.config.get(f) for f in REFRESH_FIELDS
        ):
            found.append(
                f"clis.{name} ({cli.cli}): Mirage would refresh the OAuth "
                "token itself"
            )
    store = config.store
    for group in ("namespace", "logs", "sessions", "execution"):
        block = getattr(store, group) if store is not None else None
        if isinstance(block, S3StoreBlock):
            found.append(
                _s3_refusal(f"store.{group}", block.model_dump()) or ""
            )
    return [one for one in found if one]


def missing_error(names: set[str]) -> ValueError:
    """The refusal for names the active hermes profile does not hold.

    Args:
        names (set[str]): the missing names.
    """
    listed = ", ".join(sorted(names))
    return ValueError(
        f"the workspace YAML names {listed}, which this Hermes profile "
        "does not hold; set each with `hermes config set NAME value`"
    )
