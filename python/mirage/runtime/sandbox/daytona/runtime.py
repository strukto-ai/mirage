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

import posixpath
import shlex
from typing import Any

from mirage.runtime.base import RunResult
from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.constants import STDIN_PATH, sdk_install_hint
from mirage.runtime.sandbox.daytona import sdk
from mirage.runtime.sandbox.daytona.config import DaytonaConfig


class DaytonaRuntime(RemoteSandbox):
    """A Daytona sandbox as a whole-line runtime.

    DaytonaConfig maps directly onto the create params: ``image``
    becomes an image sandbox built at create time, ``template`` names
    a prebaked snapshot, sizing maps onto Daytona's per-sandbox
    resources (``gpu`` truthy requests a GPU and forces the sandbox
    ephemeral, as Daytona requires), and ``params`` passes any other
    create option verbatim, merged last. ``api_key`` falls back to
    DAYTONA_API_KEY. Daytona's exec has no stdin and reports combined
    output, so piped bytes are uploaded and redirected in, and stderr
    comes back None.

    Args:
        options (Any): the RemoteSandbox constructor fields.
    """

    name = "daytona"
    config_cls = DaytonaConfig
    config: DaytonaConfig
    _client: Any = None
    _sandbox: Any = None

    def __init__(self, **options: Any) -> None:
        super().__init__(**options)
        if self.config.image is not None and self.config.template is not None:
            raise ValueError(
                "daytona takes image or template, not both: an image "
                "builds at create time, a template names a snapshot "
                "that is already built")

    def _ensure_client(self) -> Any:
        if sdk.AsyncDaytona is None:
            raise ImportError(sdk_install_hint("daytona"))
        if self._client is None:
            config = (sdk.DaytonaConfig(
                api_key=self.api_key) if self.api_key is not None else None)
            self._client = sdk.AsyncDaytona(config)
        return self._client

    async def create_sandbox(self) -> str:
        client = self._ensure_client()
        self._sandbox = await client.create(self._create_params())
        return str(self._sandbox.id)

    async def connect_sandbox(self, sandbox_id: str) -> None:
        client = self._ensure_client()
        self._sandbox = await client.get(sandbox_id)

    async def default_workspace_root(self) -> str:
        """$HOME/workspace: the sandbox user is not root (uid 1001
        `daytona` in the default snapshot), so a root-level /workspace
        cannot even be created; home always can."""
        response = await self._sandbox.process.exec('printf "%s" "$HOME"')
        home = str(response.result).strip()
        return posixpath.join(home or "/", "workspace")

    def _create_params(self) -> Any:
        """Map the general config onto Daytona create params."""
        shared: dict[str, Any] = {}
        if self.config.env:
            shared["env_vars"] = dict(self.config.env)
        resources = self._create_resources()
        if self.config.image is None:
            # Snapshot sandboxes fix sizing when the snapshot is
            # created; dropping sizing silently would hide that no GPU
            # was ever requested.
            if resources is not None:
                raise ValueError(
                    "daytona sizing (cpu/memory/disk/gpu) requires an "
                    "image; a snapshot sandbox fixes its sizing when the "
                    "snapshot is created")
            if self.config.template is not None:
                shared["snapshot"] = self.config.template
            shared.update(self.config.params)
            return sdk.CreateSandboxFromSnapshotParams(**shared)
        if self.config.gpu:
            shared["ephemeral"] = True
        if resources is not None:
            shared["resources"] = resources
        shared["image"] = self.config.image
        shared.update(self.config.params)
        return sdk.CreateSandboxFromImageParams(**shared)

    def _create_resources(self) -> Any:
        if not self.config.sized():
            return None
        gpu = self.config.gpu
        count = gpu if isinstance(gpu, int) else (1 if gpu else None)
        return sdk.Resources(cpu=self.config.cpu,
                             memory=self.config.memory,
                             disk=self.config.disk,
                             gpu=count)

    async def exec_line(self, line: str, stdin: bytes | None,
                        env: dict[str, str], cwd: str) -> RunResult:
        command = line
        if stdin is not None:
            await self.upload(STDIN_PATH, stdin)
            command = f"( {line} ) < {shlex.quote(STDIN_PATH)}"
        response = await self._sandbox.process.exec(command, cwd=cwd, env=env)
        return RunResult(stdout=str(response.result).encode(),
                         stderr=None,
                         exit_code=int(response.exit_code))

    async def upload(self, path: str, data: bytes) -> None:
        parent = path.rsplit("/", 1)[0]
        if parent:
            await self._sandbox.fs.create_folder(parent, "755")
        await self._sandbox.fs.upload_file(data, path)

    async def download(self, path: str) -> bytes:
        data = await self._sandbox.fs.download_file(path)
        return data if data is not None else b""

    async def close(self) -> None:
        if getattr(self, "_sandbox", None) is not None:
            if self.owned_sandbox:
                await self._client.delete(self._sandbox)
            self._sandbox = None
        if getattr(self, "_client", None) is not None:
            await self._client.close()
            self._client = None
