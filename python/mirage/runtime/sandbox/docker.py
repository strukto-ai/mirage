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
import posixpath
import shlex
from typing import Any

from mirage.runtime.base import RunResult
from mirage.runtime.sandbox.base import RemoteSandbox

_DEFAULT_IMAGE = "python:3.12-slim"

_INSTALL_HINT = ("the docker runtime needs the docker CLI on PATH "
                 "(Docker Desktop, colima, or a podman alias)")


class DockerRuntime(RemoteSandbox):
    """A local Docker container as a whole-line runtime.

    Drives the docker CLI directly (Docker Desktop, colima, or a
    podman alias all work), so there is no SDK dependency and no
    daemon socket wiring. `image` defaults to python:3.12-slim and is
    pulled on first use; `resources` maps onto --cpus/--memory/--gpus
    (disk fails loud: the default storage driver has no per-container
    limit). Containers get real stdin and separated stderr, and bind
    mounts make local files free: run_args=["-v", "/host:/mnt/data"].

    Args:
        run_args (list[str] | None): extra `docker run` flags passed
            verbatim before the image (binds, --network, --user, ...),
            the CLI-flavored sibling of the SDK runtimes'
            sandbox_params.
        options (Any): the uniform RemoteSandbox constructor fields.
    """

    name = "docker"

    def __init__(self,
                 run_args: list[str] | None = None,
                 **options: Any) -> None:
        super().__init__(**options)
        if self.resources is not None and self.resources.disk is not None:
            raise ValueError(
                "docker has no per-container disk limit on the default "
                "storage driver; omit disk from resources")
        self.run_args = list(run_args) if run_args else []

    async def _docker(self,
                      args: list[str],
                      stdin: bytes | None = None) -> tuple[bytes, bytes, int]:
        """One docker CLI invocation; the seam tests override."""
        try:
            process = await asyncio.create_subprocess_exec(
                "docker",
                *args,
                stdin=(asyncio.subprocess.PIPE
                       if stdin is not None else asyncio.subprocess.DEVNULL),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            raise RuntimeError(_INSTALL_HINT) from None
        stdout, stderr = await process.communicate(stdin)
        return stdout, stderr, process.returncode or 0

    def _resource_args(self) -> list[str]:
        args: list[str] = []
        if self.resources is None:
            return args
        if self.resources.cpu is not None:
            args += ["--cpus", str(self.resources.cpu)]
        if self.resources.memory is not None:
            args += ["--memory", f"{self.resources.memory}g"]
        if self.resources.gpu is not None:
            args += ["--gpus", str(self.resources.gpu)]
        return args

    async def create_sandbox(self) -> str:
        image = self.image if self.image is not None else _DEFAULT_IMAGE
        args = [
            "run", "-d", *self._resource_args(), *self.run_args, image,
            "sleep", "infinity"
        ]
        stdout, stderr, code = await self._docker(args)
        if code != 0:
            raise RuntimeError(f"docker run failed: {stderr.decode().strip()}")
        return stdout.decode().strip()

    async def connect_sandbox(self, sandbox_id: str) -> None:
        stdout, stderr, code = await self._docker(
            ["inspect", "--format", "{{.State.Running}}", sandbox_id])
        if code != 0:
            raise RuntimeError(
                f"docker inspect failed: {stderr.decode().strip()}")
        if stdout.decode().strip() != "true":
            raise RuntimeError(f"container {sandbox_id} is not running")

    async def default_workspace_root(self) -> str:
        """$HOME/workspace: containers usually run as root, so this is
        /root/workspace on stock images; custom-user images get their
        own home the same way."""
        stdout, _, _ = await self._docker(
            ["exec",
             str(self.sandbox_id), "sh", "-c", 'printf "%s" "$HOME"'])
        home = stdout.decode().strip()
        return posixpath.join(home or "/", "workspace")

    async def exec_line(self, line: str, stdin: bytes | None,
                        env: dict[str, str], cwd: str) -> RunResult:
        args = ["exec", "-i", "-w", cwd]
        for key, value in env.items():
            args += ["-e", f"{key}={value}"]
        args += [str(self.sandbox_id), "sh", "-c", line]
        stdout, stderr, code = await self._docker(args, stdin=stdin)
        return RunResult(stdout=stdout, stderr=stderr, exit_code=code)

    async def upload(self, path: str, data: bytes) -> None:
        parent = path.rsplit("/", 1)[0] or "/"
        script = (f"mkdir -p {shlex.quote(parent)} && "
                  f"cat > {shlex.quote(path)}")
        _, stderr, code = await self._docker(
            ["exec", "-i",
             str(self.sandbox_id), "sh", "-c", script],
            stdin=data)
        if code != 0:
            raise RuntimeError(
                f"docker upload failed: {stderr.decode().strip()}")

    async def download(self, path: str) -> bytes:
        stdout, stderr, code = await self._docker(
            ["exec", str(self.sandbox_id), "cat", path])
        if code != 0:
            raise RuntimeError(
                f"docker download failed: {stderr.decode().strip()}")
        return stdout

    async def close(self) -> None:
        if self.sandbox_id is not None and self.owned_sandbox:
            await self._docker(["rm", "-f", str(self.sandbox_id)])
