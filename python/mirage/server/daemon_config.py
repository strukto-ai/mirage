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

ALLOWED_KEYS = frozenset({
    "url",
    "socket",
    "auth_token",
    "auth_mode",
    "allowed_hosts",
    "jwt_alg",
    "jwt_issuer",
    "jwt_audience",
    "jwt_pubkey_file",
    "jwt_clock_skew",
    "jwt_authorized_parties",
    "idle_grace_seconds",
    "port",
})
NUMERIC_KEYS = frozenset({"idle_grace_seconds", "jwt_clock_skew", "port"})


class DaemonConfigError(Exception):
    """Raised when config.toml's ``[daemon]`` table is unusable."""


def validate_daemon_table(table: dict[str, Any]) -> None:
    """Reject unknown keys or wrong-typed values in a ``[daemon]`` table.

    Args:
        table (dict): parsed ``[daemon]`` table.

    Raises:
        DaemonConfigError: naming every offending key.
    """
    unknown = sorted(set(table) - ALLOWED_KEYS)
    if unknown:
        raise DaemonConfigError(
            "config.toml: the following [daemon] keys don't match any "
            f"configuration option: {', '.join(unknown)}")
    bad_types = sorted(
        k for k, v in table.items()
        if (k in NUMERIC_KEYS and not isinstance(v, (int, float))) or (
            k not in NUMERIC_KEYS and not isinstance(v, str)))
    if bad_types:
        raise DaemonConfigError(
            "config.toml: the following [daemon] keys have the wrong "
            f"type: {', '.join(bad_types)}")


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
