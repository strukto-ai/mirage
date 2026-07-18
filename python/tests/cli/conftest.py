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
import socket
import subprocess
import sys
import time

import httpx
import pytest


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_health(url: str, timeout: float = 8.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = httpx.get(f"{url}/v1/health", timeout=0.3)
            if r.status_code == 200:
                return
        except httpx.RequestError:
            pass
        time.sleep(0.1)
    raise RuntimeError(f"daemon at {url} did not start within {timeout}s")


@pytest.fixture
def daemon(tmp_path):
    """Spin up a real daemon subprocess for the test, on a free port."""
    port = _free_port()
    url = f"http://127.0.0.1:{port}"
    env = dict(os.environ)
    env["MIRAGE_DAEMON_URL"] = url
    env["MIRAGE_IDLE_GRACE_SECONDS"] = "60"
    env["MIRAGE_HOME"] = str(tmp_path)
    env.pop("MIRAGE_AUTH_TOKEN", None)
    env.pop("MIRAGE_TOKEN", None)
    log_file = tmp_path / "daemon.log"
    proc = subprocess.Popen(
        [
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
        ],
        env=env,
        stdout=open(log_file, "wb"),
        stderr=subprocess.STDOUT,
    )
    try:
        _wait_for_health(url)
        yield {"url": url, "env": env, "log": log_file}
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
