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
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from mirage.server.daemon_config import read_daemon_table
from mirage.server.paths import mirage_home
from mirage.server.ssh.constants import (
    AUTHORIZED_KEYS_NAME,
    DEFAULT_SSH_HOST,
    HOST_KEY_NAME,
    SSH_DIR,
    SSH_ENV_KEYS,
)
from mirage.server.ssh.errors import SSHConfigError
from mirage.types import JsonValue


@dataclass(frozen=True)
class SSHConfig:
    """Where the daemon's SSH endpoint listens and whom it lets in.

    The HTTPS route carries SSH whatever the port says; the TCP endpoint
    opens only with a port.

    Args:
        port (int | None): TCP port; 0 asks the OS for a free one, None
            keeps the TCP endpoint shut.
        host (str): interface to bind.
        host_key_file (Path): the server's private host key, minted on
            first start and kept, so clients' known_hosts stay valid.
        authorized_keys_file (Path): OpenSSH-format public keys allowed
            to log in, re-read on every connection so adding a key
            needs no restart.
    """

    port: int | None
    host: str
    host_key_file: Path
    authorized_keys_file: Path


def default_ssh_dir(home: Path | None = None) -> Path:
    """The directory holding the host key and authorized keys.

    Args:
        home (Path | None): the ``.mirage`` base directory. Defaults to
            ``mirage_home()``.

    Returns:
        Path: ``home/ssh``.
    """
    return (home if home is not None else mirage_home()) / SSH_DIR


def _setting(
    key: str, env: Mapping[str, str], table: Mapping[str, JsonValue]
) -> str:
    value = env.get(SSH_ENV_KEYS[key], "").strip()
    if value:
        return value
    raw = table.get(key)
    return "" if raw is None else str(raw).strip()


def _parse_port(raw: str) -> int:
    try:
        port = int(raw)
    except ValueError as exc:
        raise SSHConfigError(
            f"ssh_port must be an integer, got {raw!r}"
        ) from exc
    if not 0 < port < 65536:
        raise SSHConfigError(
            f"ssh_port must be between 1 and 65535, got {port}"
        )
    return port


def resolve_ssh_config(
    env: Mapping[str, str] | None = None,
    table: Mapping[str, JsonValue] | None = None,
    home: Path | None = None,
) -> SSHConfig:
    """Resolve the SSH settings.

    Per key the environment variable wins over the ``[daemon]`` table
    in ``config.toml``, which wins over the default. The TCP endpoint is
    off unless a port is set, so a daemon nobody configured for SSH
    never listens on a second port.

    Args:
        env (Mapping[str, str] | None): environment to read. Defaults
            to ``os.environ``.
        table (Mapping[str, JsonValue] | None): the ``[daemon]`` table.
            Defaults to reading ``$MIRAGE_HOME/config.toml`` when
            ``env`` is also defaulted; an explicit ``env`` with no
            ``table`` stays hermetic and reads no file.
        home (Path | None): the ``.mirage`` base directory the default
            key paths live under. Defaults to ``mirage_home()``.

    Returns:
        SSHConfig: the resolved settings, with no port when the TCP
            entry point is off.

    Raises:
        SSHConfigError: the port is not an integer in range.
    """
    if table is None:
        table = read_daemon_table(mirage_home()) if env is None else {}
    e = env if env is not None else os.environ
    raw_port = _setting("ssh_port", e, table)
    ssh_dir = default_ssh_dir(home)
    host_key = _setting("ssh_host_key_file", e, table)
    authorized = _setting("ssh_authorized_keys", e, table)
    return SSHConfig(
        port=_parse_port(raw_port) if raw_port else None,
        host=_setting("ssh_host", e, table) or DEFAULT_SSH_HOST,
        host_key_file=(
            Path(host_key).expanduser()
            if host_key
            else ssh_dir / HOST_KEY_NAME
        ),
        authorized_keys_file=(
            Path(authorized).expanduser()
            if authorized
            else ssh_dir / AUTHORIZED_KEYS_NAME
        ),
    )
