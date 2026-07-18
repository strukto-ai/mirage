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
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mirage.cli.env import ENV_DAEMON_URL, ENV_TOKEN
from mirage.server.auth import storage as auth_storage
from mirage.server.auth.config import (ENV_AUTH_MODE, ENV_JWT_ALG,
                                       ENV_JWT_AUDIENCE,
                                       ENV_JWT_AUTHORIZED_PARTIES,
                                       ENV_JWT_CLOCK_SKEW, ENV_JWT_ISSUER,
                                       ENV_JWT_PUBKEY_FILE)
from mirage.server.daemon_config import (ALLOWED_KEYS, NUMERIC_KEYS,
                                         DaemonConfigError, read_daemon_table)
from mirage.server.env import (ENV_ALLOWED_HOSTS, ENV_DAEMON_PORT,
                               ENV_IDLE_GRACE_SECONDS, ENV_PID_FILE,
                               ENV_SNAPSHOT_ROOT, ENV_VERSION_ROOT)
from mirage.server.host_validation_constants import DEFAULT_ALLOWED_HOSTS
from mirage.server.paths import mirage_home

DEFAULT_DAEMON_URL = "http://127.0.0.1:8765"

_ENV_FOR_KEY = {
    "url": ENV_DAEMON_URL,
    "allowed_hosts": ENV_ALLOWED_HOSTS,
    "auth_mode": ENV_AUTH_MODE,
    "jwt_alg": ENV_JWT_ALG,
    "jwt_issuer": ENV_JWT_ISSUER,
    "jwt_audience": ENV_JWT_AUDIENCE,
    "jwt_pubkey_file": ENV_JWT_PUBKEY_FILE,
    "jwt_clock_skew": ENV_JWT_CLOCK_SKEW,
    "jwt_authorized_parties": ENV_JWT_AUTHORIZED_PARTIES,
    "auth_token": ENV_TOKEN,
    "idle_grace_seconds": ENV_IDLE_GRACE_SECONDS,
    "port": ENV_DAEMON_PORT,
    "pid_file": ENV_PID_FILE,
    "version_root": ENV_VERSION_ROOT,
    "snapshot_root": ENV_SNAPSHOT_ROOT,
}


@dataclass
class DaemonSettings:
    url: str = DEFAULT_DAEMON_URL
    socket: str = ""
    auth_token: str = ""
    idle_grace_seconds: float = 30.0


def config_path() -> Path:
    return mirage_home() / "config.toml"


def load_daemon_settings(path: Path | None = None) -> DaemonSettings:
    """Load daemon settings, applying the override chain.

    Order of precedence (highest first):
        1. ``MIRAGE_DAEMON_URL`` env var
        2. ``MIRAGE_TOKEN`` env var
        3. values in ``$MIRAGE_HOME/config.toml`` (default
           ``~/.mirage/config.toml``) ``[daemon]`` table
        4. defaults

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
    settings = DaemonSettings(
        url=str(table.get("url", DEFAULT_DAEMON_URL)),
        socket=str(table.get("socket", "")),
        auth_token=str(table.get("auth_token", "")),
        idle_grace_seconds=float(table.get("idle_grace_seconds", 30.0)),
    )
    env_url = os.environ.get(ENV_DAEMON_URL)
    if env_url:
        settings.url = env_url
    env_token = os.environ.get(ENV_TOKEN)
    if env_token:
        settings.auth_token = env_token
    if not settings.auth_token:
        file_token = auth_storage.read_token_file(
            auth_storage.default_token_file())
        if file_token:
            settings.auth_token = file_token
    return settings


def _default_for_key(key: str, home: Path) -> str:
    defaults = {
        "url": DEFAULT_DAEMON_URL,
        "allowed_hosts": ",".join(DEFAULT_ALLOWED_HOSTS),
        "auth_mode": "local",
        "jwt_alg": "",
        "jwt_issuer": "",
        "jwt_audience": "",
        "jwt_pubkey_file": "",
        "jwt_clock_skew": "5",
        "jwt_authorized_parties": "",
        "socket": "",
        "auth_token": "",
        "idle_grace_seconds": "30",
        "port": "8765",
        "pid_file": str(home / "daemon.pid"),
        "version_root": str(home / "repos"),
        "snapshot_root": str(home / "snapshots"),
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
        elif str(table.get(key, "")):
            out[key] = (str(table[key]), "file")
        else:
            out[key] = (_default_for_key(key, home), "default")
    return out


def _check_key(key: str) -> None:
    if key not in ALLOWED_KEYS:
        raise DaemonConfigError(f"unknown config key: {key!r}; allowed: "
                                f"{', '.join(sorted(ALLOWED_KEYS))}")


def _format_value(key: str, value: str) -> str:
    if key in NUMERIC_KEYS:
        return value
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _config_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return path.read_text().splitlines()


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
    lines = _config_lines(use_path)
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
    lines = _config_lines(use_path)
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
        if (in_daemon and "=" in stripped and not stripped.startswith("#")
                and stripped.split("=", 1)[0].strip() == key):
            continue
        kept.append(line)
    use_path.write_text("\n".join(kept) + "\n")
    os.chmod(use_path, 0o600)
