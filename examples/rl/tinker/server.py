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

import asyncio
import os
import shutil
import time
from collections.abc import Mapping
from pathlib import Path

import aiohttp
from constants import (
    ANNOUNCE_RE,
    DEFAULT_FIXTURE,
    DEFAULT_HEALTH_POLL_INTERVAL,
    DEFAULT_SERVER_START_TIMEOUT,
    HEALTH_PATH,
    INTEG_DIR,
    RESET_PATH,
    RUN_PATH_PREFIX,
)


def announce_token(service: str) -> str:
    """Map an ``integ`` service name to its ``<SERVICE>_URL`` env key.

    Args:
        service (str): Service name under ``integ/server/<service>``.

    Returns:
        str: Uppercase environment variable name ending in ``_URL``.
    """
    return f"{service.upper().replace('-', '_')}_URL"


class ServerPool:
    """Pool of ``integ/server`` backends allocating isolated per-run endpoints.

    Supports multiple backend services within a single rollout. When a
    service is not open yet, callers wait for it to boot (or become healthy
    if configured externally); once open, each rollout immediately receives
    its own run-scoped endpoint ``{origin}/_run/{run_id}`` via ``POST /reset``.

    Args:
        fixture_root (Path): Directory holding ``<service>/<fixture>.json``.
        endpoints (Mapping[str, str] | None): Optional pre-running backend
            origins keyed by service name.
        startup_timeout (float): Seconds to wait for a backend to become ready.
    """

    def __init__(
        self,
        fixture_root: Path,
        endpoints: Mapping[str, str] | None = None,
        startup_timeout: float = DEFAULT_SERVER_START_TIMEOUT,
    ) -> None:
        self._fixture_root = fixture_root.resolve()
        self._configured = {
            k: v.rstrip("/") for k, v in (endpoints or {}).items() if v
        }
        self._startup_timeout = startup_timeout
        self._origins: dict[str, str] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._procs: dict[str, asyncio.subprocess.Process] = {}
        self._session: aiohttp.ClientSession | None = None

    def _http(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def ensure_open(
        self, service: str, default_fixture: str = DEFAULT_FIXTURE
    ) -> str:
        """Return a ready origin URL for ``service``, waiting if still opening.

        Args:
            service (str): Backend service name (e.g. ``github``, ``linear``).
            default_fixture (str): Initial fixture if spawning the server.

        Returns:
            str: Ready origin URL for ``service``.
        """
        if service in self._origins:
            return self._origins[service]

        lock = self._locks.setdefault(service, asyncio.Lock())
        async with lock:
            if service in self._origins:
                return self._origins[service]

            token = announce_token(service)
            external = self._configured.get(service) or os.environ.get(
                token, ""
            ).rstrip("/")
            if external:
                await self._wait_until_healthy(external)
                self._origins[service] = external
                return external

            origin = await self._spawn_service(service, default_fixture, token)
            self._origins[service] = origin
            return origin

    async def _wait_until_healthy(self, origin: str) -> None:
        deadline = time.monotonic() + self._startup_timeout
        session = self._http()
        last_err: Exception | None = None
        while time.monotonic() < deadline:
            try:
                async with session.get(f"{origin}{HEALTH_PATH}") as resp:
                    if resp.status < 500:
                        return
            except aiohttp.ClientError as exc:
                last_err = exc
            await asyncio.sleep(DEFAULT_HEALTH_POLL_INTERVAL)
        raise RuntimeError(
            f"Backend at {origin} not ready within "
            f"{self._startup_timeout}s: {last_err}"
        )

    async def _spawn_service(
        self, service: str, fixture: str, expected_token: str
    ) -> str:
        pnpm = shutil.which("pnpm")
        if pnpm is None:
            raise RuntimeError(
                f"pnpm is not on PATH and {expected_token} is unset. Build "
                "integ (`cd integ && pnpm install && pnpm run "
                f"prisma:clients`) or set {expected_token}."
            )
        proc = await asyncio.create_subprocess_exec(
            pnpm,
            "--dir",
            str(INTEG_DIR),
            "exec",
            "tsx",
            f"server/{service}/main.ts",
            "--port",
            "0",
            "--fixture-root",
            str(self._fixture_root),
            "--fixture",
            fixture,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._procs[service] = proc
        return await asyncio.wait_for(
            self._read_announce(proc, service, expected_token),
            timeout=self._startup_timeout,
        )

    async def _read_announce(
        self,
        proc: asyncio.subprocess.Process,
        service: str,
        expected_token: str,
    ) -> str:
        assert proc.stdout is not None
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                err = b""
                if proc.stderr is not None:
                    err = await proc.stderr.read()
                detail = err.decode("utf-8", errors="replace").strip()
                raise RuntimeError(
                    f"integ/server/{service} exited early: {detail}"
                )
            line = raw.decode("utf-8", errors="replace").strip()
            match = ANNOUNCE_RE.match(line)
            if match and match.group(1) == expected_token:
                return match.group(2).rstrip("/")

    async def _allocate_one(
        self, run_id: str, service: str, fixture: str
    ) -> tuple[str, str]:
        origin = await self.ensure_open(service, default_fixture=fixture)
        async with self._http().post(
            f"{origin}{RESET_PATH}",
            json={"run": run_id, "fixture": fixture},
        ) as resp:
            resp.raise_for_status()
        run_url = f"{origin}/{RUN_PATH_PREFIX}/{run_id}"
        return announce_token(service), run_url

    async def allocate_endpoints(
        self, run_id: str, backends: Mapping[str, str]
    ) -> dict[str, str]:
        """Ensure every backend is open and return per-run endpoint URLs.

        Args:
            run_id (str): Unique rollout identifier (8-char hex).
            backends (Mapping[str, str]): Mapping of ``service -> fixture``.

        Returns:
            dict[str, str]: Env map of ``<SERVICE>_URL -> {origin}/_run/{id}``.
        """
        if not backends:
            return {}
        pairs = await asyncio.gather(
            *(
                self._allocate_one(run_id, service, fixture)
                for service, fixture in sorted(backends.items())
            )
        )
        return dict(pairs)

    async def close(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None
        for proc in self._procs.values():
            if proc.returncode is None:
                proc.terminate()
                await proc.wait()
        self._procs.clear()
        self._origins.clear()
