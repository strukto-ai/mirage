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

import tomllib
from pathlib import Path
from typing import Any

ALLOWED_KEYS = frozenset(
    {
        "url",
        "auth_token",
        "auth_mode",
        "allowed_hosts",
        "forwarded_allow_ips",
        "jwt_alg",
        "jwt_issuer",
        "jwt_audience",
        "jwt_pubkey",
        "jwt_pubkey_file",
        "jwt_jwks_url",
        "jwt_clock_skew_seconds",
        "jwt_authorized_parties",
        "login_client_id",
        "idle_grace_seconds",
        "graceful_timeout",
        "max_workspaces",
        "max_sessions",
        "max_memory",
        "max_env",
        "max_processes",
        "max_line_seconds",
        "rate_limits",
        "policy_file",
        "resource_store",
        "port",
        "ssh_port",
        "ssh_host",
        "ssh_host_key_file",
        "ssh_authorized_keys",
        "workers",
        "worker_type",
    }
)
NUMERIC_KEYS = frozenset(
    {
        "idle_grace_seconds",
        "graceful_timeout",
        "jwt_clock_skew_seconds",
        "max_workspaces",
        "max_sessions",
        "max_processes",
        "max_line_seconds",
        "port",
        "ssh_port",
        "workers",
    }
)
# Keys that take a size: a whole number of bytes, or a string such as
# "256MB".
SIZE_KEYS = frozenset({"max_memory", "max_env"})
DEFAULT_RATE_LIMITS = "ip=1000/minute"
RENAMED_KEYS = {"jwt_clock_skew": "jwt_clock_skew_seconds"}


class DaemonConfigError(Exception):
    """Raised when config.toml's ``[daemon]`` table is unusable."""


def renamed_key_message(key: str) -> str:
    """Name the new key for a ``[daemon]`` key under its old name.

    Args:
        key (str): a key in :data:`RENAMED_KEYS`.

    Returns:
        str: the message telling the user to rename it.
    """
    return (
        f"config.toml: `daemon.{key}` is now "
        f"`daemon.{RENAMED_KEYS[key]}`; rename the key"
    )


def validate_daemon_table(table: dict[str, Any]) -> None:
    """Reject unknown keys or wrong-typed values in a ``[daemon]`` table.

    Args:
        table (dict): parsed ``[daemon]`` table.

    Raises:
        DaemonConfigError: naming the new key for a renamed one, else
            every offending key.
    """
    renamed = sorted(set(table) & RENAMED_KEYS.keys())
    if renamed:
        raise DaemonConfigError(
            "; ".join(renamed_key_message(k) for k in renamed)
        )
    unknown = sorted(set(table) - ALLOWED_KEYS)
    if unknown:
        raise DaemonConfigError(
            "config.toml: the following [daemon] keys don't match any "
            f"configuration option: {', '.join(unknown)}"
        )
    bad_types = sorted(
        k
        for k, v in table.items()
        if (k in NUMERIC_KEYS and not isinstance(v, (int, float)))
        or (k in SIZE_KEYS and not isinstance(v, (int, str)))
        or (k not in NUMERIC_KEYS | SIZE_KEYS and not isinstance(v, str))
    )
    if bad_types:
        raise DaemonConfigError(
            "config.toml: the following [daemon] keys have the wrong "
            f"type: {', '.join(bad_types)}"
        )


def read_daemon_table(home: Path) -> dict[str, Any]:
    """Read the ``[daemon]`` table from ``home/config.toml``.

    Args:
        home (Path): the ``.mirage`` base directory. The config file is
            ``home/config.toml``.

    Returns:
        dict: the ``[daemon]`` table, or ``{}`` if the file or table is
            absent.

    Raises:
        DaemonConfigError: the file exists but is not valid TOML.
    """
    path = home / "config.toml"
    if not path.exists():
        return {}
    try:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        raise DaemonConfigError(f"malformed {path}: {e}") from e
    table = data.get("daemon", {})
    return table if isinstance(table, dict) else {}
