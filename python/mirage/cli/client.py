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
import subprocess
import sys
import time
from urllib.parse import urlparse

import httpx

from mirage.cli.env import ENV_AUTH_MODE, ENV_AUTH_TOKEN
from mirage.cli.settings import DaemonSettings, load_daemon_settings
from mirage.server.auth import AuthMode
from mirage.server.auth import storage as auth_storage
from mirage.server.daemon_config import (read_daemon_table,
                                         validate_daemon_table)
from mirage.server.env import ENV_DAEMON_PORT
from mirage.server.paths import mirage_home


class DaemonUnreachable(RuntimeError):
    pass


class DaemonClient:
    """Thin httpx wrapper around the Mirage daemon REST API.

    Constructs once per CLI invocation and is reused across calls.
    Handles auth header injection, daemon auto-spawn on first
    ``workspace --create``, and discovery via the settings chain.
    """

    def __init__(self, settings: DaemonSettings) -> None:
        self.settings = settings
        self._client = httpx.Client(base_url=settings.url, timeout=60.0)

    def __enter__(self) -> "DaemonClient":
        return self

    def __exit__(self, *exc_info) -> None:
        self._client.close()

    def _headers(self) -> dict[str, str]:
        if self.settings.auth_token:
            return {"Authorization": f"Bearer {self.settings.auth_token}"}
        return {}

    def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        headers = {**self._headers(), **kwargs.pop("headers", {})}
        return self._client.request(method, path, headers=headers, **kwargs)

    def is_reachable(self, timeout: float = 0.5) -> bool:
        try:
            r = self._client.get("/v1/health",
                                 timeout=timeout,
                                 headers=self._headers())
            return r.status_code == 200
        except httpx.RequestError:
            return False

    def ensure_running(self,
                       startup_timeout: float = 5.0,
                       allow_spawn: bool = True) -> None:
        """Ensure the daemon is reachable, optionally spawning it.

        Args:
            startup_timeout (float): seconds to wait for the spawned
                daemon to answer ``/v1/health``.
            allow_spawn (bool): if True and the daemon is unreachable,
                fork-execs ``uvicorn mirage.server.app:app`` detached.

        Raises:
            DaemonUnreachable: daemon is not reachable and either
                ``allow_spawn=False`` or the spawned daemon failed to
                come up within ``startup_timeout``.
        """
        if self.is_reachable():
            return
        if not allow_spawn:
            raise DaemonUnreachable(
                f"daemon not reachable at {self.settings.url}; "
                "run `mirage workspace --create CONFIG.yaml` to spawn one")
        self._spawn_daemon()
        deadline = time.monotonic() + startup_timeout
        while time.monotonic() < deadline:
            if self.is_reachable(timeout=0.3):
                return
            time.sleep(0.1)
        raise DaemonUnreachable(
            f"daemon spawned but did not answer /v1/health within "
            f"{startup_timeout:.1f}s")

    def _spawn_daemon(self) -> None:
        table = read_daemon_table(mirage_home())
        validate_daemon_table(table)
        port = self._resolve_port(table)
        env = dict(os.environ)
        if not self.settings.auth_token:
            self.settings.auth_token = auth_storage.ensure_token_file(
                auth_storage.default_token_file())
        env[ENV_AUTH_TOKEN] = self.settings.auth_token
        if ENV_AUTH_MODE not in env and not table.get("auth_mode"):
            env[ENV_AUTH_MODE] = AuthMode.LOCAL.value
        cmd = [
            sys.executable,
            "-m",
            "uvicorn",
            "mirage.server.daemon:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ]
        log_dir = mirage_home()
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / "daemon.log"
        with open(log_file, "ab") as f:
            subprocess.Popen(
                cmd,
                env=env,
                stdout=f,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )

    def _resolve_port(self, table: dict) -> int:
        """Resolve the listen port for a spawned daemon.

        Priority: ``$MIRAGE_DAEMON_PORT``, then the ``port`` key in
        ``config.toml`` ``[daemon]``, then the port embedded in the
        client ``url`` setting, then 8765.

        Args:
            table (dict): the already-read ``[daemon]`` table.

        Returns:
            int: the port to bind.
        """
        env_port = os.environ.get(ENV_DAEMON_PORT)
        if env_port:
            return int(env_port)
        config_port = table.get("port")
        if config_port:
            return int(config_port)
        return self._port_from_url()

    def _port_from_url(self) -> int:
        parsed = urlparse(self.settings.url)
        return parsed.port or 8765


def make_client() -> DaemonClient:
    return DaemonClient(load_daemon_settings())
