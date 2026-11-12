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
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import typer

from mirage.cli.constants import DEFAULT_PORT, LOCAL
from mirage.cli.credentials import (
    ContextError,
    Login,
    current_name,
    login_path,
    read_context,
    read_login,
    write_context,
)
from mirage.cli.env import ENV_DAEMON_URL, ENV_TOKEN, ENV_WORKSPACE
from mirage.cli.output import fail
from mirage.server.auth import storage as auth_storage
from mirage.server.auth.config import CONFIG_ENV_KEYS
from mirage.server.daemon_config import (
    ALLOWED_KEYS,
    DEFAULT_RATE_LIMITS,
    NUMERIC_KEYS,
    RENAMED_KEYS,
    DaemonConfigError,
    read_daemon_table,
    renamed_key_message,
)
from mirage.server.env import (
    ENV_ALLOWED_HOSTS,
    ENV_DAEMON_PORT,
    ENV_FORWARDED_ALLOW_IPS,
    ENV_GRACEFUL_TIMEOUT,
    ENV_IDLE_GRACE_SECONDS,
    ENV_MAX_ENV,
    ENV_MAX_LINE_SECONDS,
    ENV_MAX_MEMORY,
    ENV_MAX_PROCESSES,
    ENV_MAX_SESSIONS,
    ENV_MAX_WORKSPACES,
    ENV_POLICY_FILE,
    ENV_RATE_LIMITS,
    ENV_RESOURCE_STORE,
    ENV_WORKER_TYPE,
    ENV_WORKERS,
)
from mirage.server.host_validation_constants import DEFAULT_ALLOWED_HOSTS
from mirage.server.paths import mirage_home
from mirage.server.ssh.config import default_ssh_dir
from mirage.server.ssh.constants import (
    AUTHORIZED_KEYS_NAME,
    DEFAULT_SSH_HOST,
    HOST_KEY_NAME,
    SSH_ENV_KEYS,
)

DEFAULT_DAEMON_URL = "http://127.0.0.1:8765"

_ENV_FOR_KEY = {
    "url": ENV_DAEMON_URL,
    "allowed_hosts": ENV_ALLOWED_HOSTS,
    "forwarded_allow_ips": ENV_FORWARDED_ALLOW_IPS,
    **CONFIG_ENV_KEYS,
    "auth_token": ENV_TOKEN,
    "idle_grace_seconds": ENV_IDLE_GRACE_SECONDS,
    "graceful_timeout": ENV_GRACEFUL_TIMEOUT,
    "max_workspaces": ENV_MAX_WORKSPACES,
    "max_sessions": ENV_MAX_SESSIONS,
    "max_memory": ENV_MAX_MEMORY,
    "max_env": ENV_MAX_ENV,
    "max_processes": ENV_MAX_PROCESSES,
    "max_line_seconds": ENV_MAX_LINE_SECONDS,
    "workers": ENV_WORKERS,
    "worker_type": ENV_WORKER_TYPE,
    "rate_limits": ENV_RATE_LIMITS,
    "policy_file": ENV_POLICY_FILE,
    "resource_store": ENV_RESOURCE_STORE,
    "port": ENV_DAEMON_PORT,
    **SSH_ENV_KEYS,
}


def default_local_url(table: dict[str, Any]) -> str:
    """The URL ``local`` follows when it keeps none of its own:
    config.toml's ``url``, else this machine at the port a spawned
    daemon listens on.

    Args:
        table (dict[str, Any]): config.toml's ``[daemon]`` table.

    Returns:
        str: the URL.
    """
    port = (
        os.environ.get(ENV_DAEMON_PORT)
        or str(table.get("port", ""))
        or DEFAULT_PORT
    )
    return str(table.get("url", "")) or f"http://127.0.0.1:{port}"


def local_url(table: dict[str, Any]) -> str:
    """The ``local`` context's URL: the one it logged in to, else
    ``default_local_url``.

    Args:
        table (dict[str, Any]): config.toml's ``[daemon]`` table.

    Returns:
        str: the URL.
    """
    local = read_context(LOCAL)
    return (local.url if local else "") or default_local_url(table)


def current_workspace() -> str | None:
    """The workspace a command uses when given none:
    ``$MIRAGE_WORKSPACE``, else the current context's.

    Returns:
        str | None: the workspace, or None when none is selected.
    """
    env = os.environ.get(ENV_WORKSPACE)
    if env:
        return env
    context = read_context(current_name())
    return context.workspace if context else None


def resolve_workspace(given: str | None) -> str:
    """The workspace to act on: ``-w``, else ``$MIRAGE_WORKSPACE``,
    else the current context's.

    Args:
        given (str | None): the ``-w`` value.

    Returns:
        str: the workspace.
    """
    found = given or current_workspace()
    if not found:
        fail(
            "no workspace selected · run `mirage workspace use <id>` "
            "or pass -w",
            2,
        )
    return found


def header(action: str, name: str | None = None) -> None:
    """Say on a terminal which context and team a command acted in,
    as ``strukto · team acme · created demo``.

    Args:
        action (str): what the command did.
        name (str | None): the context; the current one when None.
    """
    if not sys.stderr.isatty():
        return
    name = name or current_name()
    context = read_context(name)
    team = context.team if context else None
    parts = [name, *([f"team {team}"] if team else []), action]
    typer.echo(" · ".join(parts), err=True)


def use_workspace(name: str, workspace_id: str) -> None:
    """Make a workspace a context's current one.

    Args:
        name (str): the context, as the command chose it.
        workspace_id (str): the workspace.

    Raises:
        ContextError: the context was deleted meanwhile.
    """
    context = read_context(name)
    if context is None:
        raise ContextError(f"no context {name!r}")
    context.workspace = workspace_id
    write_context(name, context)


def is_local_url(url: str) -> bool:
    """Whether a daemon URL points at this machine.

    Only such a URL may use the local token file or start a daemon,
    so neither the file's token nor a spawn ever goes to a remote host.

    Args:
        url (str): the daemon URL.

    Returns:
        bool: True when its host is a loopback name.
    """
    return (urlsplit(url).hostname or "") in DEFAULT_ALLOWED_HOSTS


@dataclass
class DaemonSettings:
    context: str = LOCAL
    url: str = DEFAULT_DAEMON_URL
    socket: str = ""
    auth_token: str = ""
    idle_grace_seconds: float = 30.0
    login: Login | None = None


def config_path() -> Path:
    return mirage_home() / "config.toml"


def load_daemon_settings(path: Path | None = None) -> DaemonSettings:
    """Load the settings for the current context.

    The URL is ``MIRAGE_DAEMON_URL``, else the context's: a context
    made by ``mirage login`` keeps its URL, and ``local`` follows
    config.toml. The token is ``MIRAGE_TOKEN``, else, for ``local``
    only, config.toml's ``auth_token``. With neither, the context's
    login gives one when it was made for this URL, and then a local
    URL takes the token file's.

    Args:
        path (Path | None): config file location. Defaults to
            ``config_path()``.

    Returns:
        DaemonSettings: resolved settings.
    """
    use_path = path or config_path()
    if path is not None:
        if use_path.exists():
            with open(use_path, "rb") as f:
                table = tomllib.load(f).get("daemon", {})
        else:
            table = {}
    else:
        table = read_daemon_table(mirage_home())
    name = current_name()
    local = name == LOCAL
    context = read_context(name)
    if context is None:
        raise ContextError(f"no context {name!r}; run `mirage context list`")
    settings = DaemonSettings(
        context=name,
        url=local_url(table) if local else context.url,
        socket=str(table.get("socket", "")) if local else "",
        auth_token=str(table.get("auth_token", "")) if local else "",
        idle_grace_seconds=float(table.get("idle_grace_seconds", 30.0)),
    )
    env_url = os.environ.get(ENV_DAEMON_URL)
    if env_url:
        settings.url = env_url
    env_token = os.environ.get(ENV_TOKEN)
    if env_token:
        settings.auth_token = env_token
    if not settings.auth_token:
        login = read_login(login_path(name))
        if login is not None and login.url == settings.url.rstrip("/"):
            settings.login = login
            return settings
    if not settings.auth_token and is_local_url(settings.url):
        file_token = auth_storage.read_token_file(
            auth_storage.default_token_file()
        )
        if file_token:
            settings.auth_token = file_token
    return settings


def _default_for_key(key: str) -> str:
    defaults = {
        "url": DEFAULT_DAEMON_URL,
        "allowed_hosts": ",".join(DEFAULT_ALLOWED_HOSTS),
        "forwarded_allow_ips": "",
        "auth_mode": "local",
        "jwt_alg": "",
        "jwt_issuer": "",
        "jwt_audience": "",
        "jwt_pubkey": "",
        "jwt_pubkey_file": "",
        "jwt_jwks_url": "",
        "jwt_clock_skew_seconds": "5",
        "jwt_authorized_parties": "",
        "login_client_id": "",
        "socket": "",
        "auth_token": "",
        "idle_grace_seconds": "30",
        "graceful_timeout": "0",
        "max_workspaces": "",
        "max_sessions": "",
        "max_memory": "",
        "max_env": "",
        "max_processes": "",
        "max_line_seconds": "",
        "workers": "1",
        "worker_type": "",
        "rate_limits": DEFAULT_RATE_LIMITS,
        "policy_file": "",
        "resource_store": "files",
        "port": "8765",
        "ssh_port": "",
        "ssh_host": DEFAULT_SSH_HOST,
        "ssh_host_key_file": str(default_ssh_dir() / HOST_KEY_NAME),
        "ssh_authorized_keys": str(default_ssh_dir() / AUTHORIZED_KEYS_NAME),
    }
    return defaults[key]


def resolved_config() -> dict[str, tuple[str, str]]:
    """Resolve every config key to its effective value and origin.

    Origin is ``"env <NAME>"``, ``"file"``, or ``"default"``, applying
    the same precedence the daemon and CLI use (env > file > default;
    explicit per-call arguments are not represented here).

    Returns:
        dict[str, tuple[str, str]]: key to (effective value, origin).
    """
    home = mirage_home()
    table = read_daemon_table(home)
    out: dict[str, tuple[str, str]] = {}
    for key in sorted(ALLOWED_KEYS):
        env_name = _ENV_FOR_KEY.get(key)
        env_value = os.environ.get(env_name) if env_name else None
        if env_value:
            out[key] = (env_value, f"env {env_name}")
        elif str(table.get(key, "")) or (
            key == "rate_limits" and key in table
        ):
            out[key] = (str(table[key]), "file")
        else:
            out[key] = (_default_for_key(key), "default")
    return out


def _check_key(key: str) -> None:
    if key in RENAMED_KEYS:
        raise DaemonConfigError(renamed_key_message(key))
    if key not in ALLOWED_KEYS:
        raise DaemonConfigError(
            f"unknown config key: {key!r}; allowed: "
            f"{', '.join(sorted(ALLOWED_KEYS))}"
        )


def _format_value(key: str, value: str) -> str:
    if key in NUMERIC_KEYS:
        return value
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
    )
    return f'"{escaped}"'


def list_config(path: Path | None = None) -> dict[str, Any]:
    """Return the ``[daemon]`` table as written in the config file.

    Args:
        path (Path | None): config file. Defaults to ``config_path()``.

    Returns:
        dict: file-level key/value strings (no env or default folding).

    Raises:
        DaemonConfigError: the file exists but is not valid TOML.
    """
    use_path = path or config_path()
    if not use_path.exists():
        return {}
    try:
        with open(use_path, "rb") as f:
            table = tomllib.load(f).get("daemon", {})
    except tomllib.TOMLDecodeError as e:
        raise DaemonConfigError(f"malformed {use_path}: {e}") from e
    return {k: str(v) for k, v in table.items()}


def get_config(key: str, path: Path | None = None) -> str | None:
    """Return one ``[daemon]`` key's file value, or ``None`` if unset.

    Args:
        key (str): a key in :data:`ALLOWED_KEYS`.
        path (Path | None): config file. Defaults to ``config_path()``.

    Returns:
        str | None: the value, or ``None`` if absent.
    """
    _check_key(key)
    return list_config(path).get(key)


def set_config(key: str, value: str, path: Path | None = None) -> None:
    """Write ``key = value`` into the ``[daemon]`` table, in place.

    Creates the file and ``[daemon]`` header if missing, updates the key
    line if present, otherwise appends it inside ``[daemon]``. Comments
    and unrelated lines are preserved.

    Args:
        key (str): a key in :data:`ALLOWED_KEYS`.
        value (str): the value to store.
        path (Path | None): config file. Defaults to ``config_path()``.
    """
    _check_key(key)
    use_path = path or config_path()
    lines = use_path.read_text().splitlines() if use_path.exists() else []
    rendered = f"{key} = {_format_value(key, value)}"
    header_idx = None
    for i, line in enumerate(lines):
        if line.strip() == "[daemon]":
            header_idx = i
            break
    if header_idx is None:
        if lines and lines[-1].strip() != "":
            lines.append("")
        lines.append("[daemon]")
        lines.append(rendered)
    else:
        end = len(lines)
        for i in range(header_idx + 1, len(lines)):
            if lines[i].strip().startswith("["):
                end = i
                break
        for i in range(header_idx + 1, end):
            stripped = lines[i].strip()
            if stripped.startswith("#") or "=" not in stripped:
                continue
            if stripped.split("=", 1)[0].strip() == key:
                lines[i] = rendered
                break
        else:
            lines.insert(end, rendered)
    use_path.parent.mkdir(parents=True, exist_ok=True)
    use_path.write_text("\n".join(lines) + "\n")
    os.chmod(use_path, 0o600)


def unset_config(key: str, path: Path | None = None) -> None:
    """Remove ``key`` from the ``[daemon]`` table if present.

    Unknown keys are allowed so a file the daemon refuses to load can
    be repaired from the CLI.

    Args:
        key (str): any key present in the file.
        path (Path | None): config file. Defaults to ``config_path()``.
    """
    use_path = path or config_path()
    if not use_path.exists():
        return
    lines = use_path.read_text().splitlines()
    kept = []
    in_daemon = False
    for line in lines:
        stripped = line.strip()
        if stripped == "[daemon]":
            in_daemon = True
            kept.append(line)
            continue
        if stripped.startswith("["):
            in_daemon = False
        if (
            in_daemon
            and "=" in stripped
            and not stripped.startswith("#")
            and stripped.split("=", 1)[0].strip() == key
        ):
            continue
        kept.append(line)
    use_path.write_text("\n".join(kept) + "\n")
    os.chmod(use_path, 0o600)
