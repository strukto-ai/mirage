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
from mirage.runtime.sandbox.constants import (DOCKER_CLI_HINT,
                                              DOCKER_DEFAULT_IMAGE)


class DockerRuntime(RemoteSandbox):
    """A local Docker container as a whole-line runtime.

    Drives the docker CLI directly (Docker Desktop, colima, or a
    podman alias all work), so there is no SDK dependency and no
    daemon socket wiring. The general SandboxConfig maps onto the CLI:
    ``image`` is pulled on first use (python:3.12-slim when omitted),
    sizing becomes --cpus/--memory/--gpus (``disk`` fails loud: the
    default storage driver has no per-container limit), and ``args``
    passes any extra `docker run` flag verbatim before the image
    (binds, --cap-add, --network, --user, ...). ``template`` and
    ``params`` are SDK concepts and fail loud. Containers get real
    stdin and separated stderr.

    Args:
        options (Any): the RemoteSandbox constructor fields.
    """

    name = "docker"

    def __init__(self, **options: Any) -> None:
        super().__init__(**options)
        if self.config.template is not None:
            raise ValueError(
                "docker boots images, not prebuilt templates; pass the "
                "built image's name as config image instead")
        if self.config.disk is not None:
            raise ValueError(
                "docker has no per-container disk limit on the default "
                "storage driver; omit disk from the config")
        if self.config.params:
            raise ValueError(
                "docker is CLI-driven and takes no SDK create params; "
                "pass `docker run` flags through config args instead")

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
            raise RuntimeError(DOCKER_CLI_HINT) from None
        stdout, stderr = await process.communicate(stdin)
        return stdout, stderr, process.returncode or 0

    def _resource_args(self) -> list[str]:
        args: list[str] = []
        if self.config.cpu is not None:
            args += ["--cpus", str(self.config.cpu)]
        if self.config.memory is not None:
            args += ["--memory", f"{self.config.memory}g"]
        if self.config.gpu is not None:
            args += ["--gpus", str(self.config.gpu)]
        return args

    async def create_sandbox(self) -> str:
        image = (self.config.image
                 if self.config.image is not None else DOCKER_DEFAULT_IMAGE)
        args = [
            "run", "-d", *self._resource_args(), *self.config.args, image,
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
