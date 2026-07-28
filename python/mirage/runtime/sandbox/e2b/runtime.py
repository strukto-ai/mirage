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
from mirage.runtime.sandbox.e2b import sdk


class E2BRuntime(RemoteSandbox):
    """An E2B sandbox as a whole-line runtime.

    E2B has no inline image builds and no per-sandbox sizing: both are
    baked into a named template (`e2b template build`), so ``image``
    and sizing fail loud, ``template`` selects the prebuilt
    environment (E2B's default template when omitted), and ``params``
    passes any other AsyncSandbox create kwarg verbatim (timeout,
    metadata, allow_internet_access, ...), merged last so it can
    override anything computed here. ``api_key`` falls back to
    E2B_API_KEY. E2B's exec reports stdout and stderr separately, so
    both stream back real; it takes no stdin, so piped bytes are
    uploaded and redirected in.

    Args:
        options (Any): the RemoteSandbox constructor fields.
    """

    name = "e2b"
    _sandbox: Any = None

    def __init__(self, **options: Any) -> None:
        super().__init__(**options)
        if self.config.image is not None:
            raise ValueError(
                "e2b has no inline image builds: build a template with "
                "'e2b template build' and pass template instead of image")
        if self.config.sized():
            raise ValueError(
                "e2b fixes sizing in the template, not per sandbox: bake "
                "cpu/memory into the template instead of sizing the config")
        if self.config.args:
            raise ValueError(
                "e2b is SDK-driven and takes no CLI args; pass create "
                "options through config params instead")

    def _api_params(self) -> dict[str, Any]:
        return {"api_key": self.api_key} if self.api_key is not None else {}

    async def create_sandbox(self) -> str:
        if sdk.AsyncSandbox is None:
            raise ImportError(sdk_install_hint("e2b"))
        params: dict[str, Any] = self._api_params()
        if self.config.template is not None:
            params["template"] = self.config.template
        if self.config.env:
            params["envs"] = dict(self.config.env)
        params.update(self.config.params)
        self._sandbox = await sdk.AsyncSandbox.create(**params)
        return str(self._sandbox.sandbox_id)

    async def connect_sandbox(self, sandbox_id: str) -> None:
        if sdk.AsyncSandbox is None:
            raise ImportError(sdk_install_hint("e2b"))
        self._sandbox = await sdk.AsyncSandbox.connect(sandbox_id,
                                                       **self._api_params())

    async def default_workspace_root(self) -> str:
        """$HOME/workspace: the default template user is `user` (uid
        1000), so a root-level /workspace is not writable; home is."""
        result = await self._sandbox.commands.run('printf "%s" "$HOME"')
        home = str(result.stdout).strip()
        return posixpath.join(home or "/", "workspace")

    async def exec_line(self, line: str, stdin: bytes | None,
                        env: dict[str, str], cwd: str) -> RunResult:
        command = line
        if stdin is not None:
            await self.upload(STDIN_PATH, stdin)
            command = f"( {line} ) < {shlex.quote(STDIN_PATH)}"
        try:
            result = await self._sandbox.commands.run(command,
                                                      envs=env,
                                                      cwd=cwd)
        except sdk.CommandExitException as exc:
            result = exc
        return RunResult(stdout=str(result.stdout).encode(),
                         stderr=str(result.stderr).encode(),
                         exit_code=int(result.exit_code))

    async def upload(self, path: str, data: bytes) -> None:
        parent = path.rsplit("/", 1)[0]
        if parent:
            await self._sandbox.files.make_dir(parent)
        await self._sandbox.files.write(path, data)

    async def download(self, path: str) -> bytes:
        data = await self._sandbox.files.read(path, format="bytes")
        return bytes(data)

    async def close(self) -> None:
        if getattr(self, "_sandbox", None) is not None:
            if self.owned_sandbox:
                await self._sandbox.kill()
            self._sandbox = None
