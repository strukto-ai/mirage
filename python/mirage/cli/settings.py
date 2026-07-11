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

from mirage.cli.env import ENV_DAEMON_URL, ENV_TOKEN
from mirage.server.auth import storage as auth_storage
from mirage.server.paths import mirage_home

DEFAULT_DAEMON_URL = "http://127.0.0.1:8765"


@dataclass
class DaemonSettings:
    url: str = DEFAULT_DAEMON_URL
    socket: str = ""
    auth_token: str = ""
    idle_grace_seconds: float = 30.0


def config_path() -> Path:
    return mirage_home() / "config.toml"


def _read_toml(path: Path) -> dict:
    if not path.exists():
        return {}
    with open(path, "rb") as f:
        return tomllib.load(f)


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
    table = _read_toml(use_path).get("daemon", {})
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
