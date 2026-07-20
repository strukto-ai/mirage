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

AsyncSandbox: Any
CommandExitException: Any
try:
    from e2b import AsyncSandbox as _AsyncSandbox
    from e2b import CommandExitException as _CommandExitException
except ImportError:
    AsyncSandbox = None
    CommandExitException = None
else:
    AsyncSandbox = _AsyncSandbox
    CommandExitException = _CommandExitException

_INSTALL_HINT = ("the e2b runtime needs the e2b SDK; install with: "
                 "pip install mirage-ai[e2b]")

_STDIN_PATH = "/tmp/.mirage_stdin"


class E2BRuntime(RemoteSandbox):
    """An E2B sandbox as a whole-line runtime.

    E2B has no inline image builds and no per-sandbox sizing: both are
    baked into a named template (`e2b template build`), so `image` and
    `resources` fail loud and `template` selects the prebuilt
    environment. `api_key` falls back to E2B_API_KEY. E2B's exec
    reports stdout and stderr separately, so both stream back real.

    Args:
        template (str | None): name or id of the E2B template to boot
            (E2B's default template when omitted).
        sandbox_params (dict[str, Any] | None): extra AsyncSandbox
            create kwargs passed verbatim to the SDK, merged last so
            they can also override anything computed here (timeout,
            metadata, allow_internet_access, ...).
        options (Any): the uniform RemoteSandbox constructor fields.
    """

    name = "e2b"
    _sandbox: Any = None

    def __init__(self,
                 template: str | None = None,
                 sandbox_params: dict[str, Any] | None = None,
                 **options: Any) -> None:
        super().__init__(**options)
        if self.image is not None:
            raise ValueError(
                "e2b has no inline image builds: build a template with "
                "'e2b template build' and pass template= instead of image=")
        if self.resources is not None:
            raise ValueError(
                "e2b fixes sizing in the template, not per sandbox: bake "
                "cpu/memory into the template instead of resources=")
        self.template = template
        self.sandbox_params = dict(sandbox_params) if sandbox_params else {}

    def _api_params(self) -> dict[str, Any]:
        return {"api_key": self.api_key} if self.api_key is not None else {}

    async def create_sandbox(self) -> str:
        if AsyncSandbox is None:
            raise ImportError(_INSTALL_HINT)
        params: dict[str, Any] = self._api_params()
        if self.template is not None:
            params["template"] = self.template
        if self.env:
            params["envs"] = dict(self.env)
        params.update(self.sandbox_params)
        self._sandbox = await AsyncSandbox.create(**params)
        return str(self._sandbox.sandbox_id)

    async def connect_sandbox(self, sandbox_id: str) -> None:
        if AsyncSandbox is None:
            raise ImportError(_INSTALL_HINT)
        self._sandbox = await AsyncSandbox.connect(sandbox_id,
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
            await self.upload(_STDIN_PATH, stdin)
            command = f"( {line} ) < {shlex.quote(_STDIN_PATH)}"
        try:
            result = await self._sandbox.commands.run(command,
                                                      envs=env,
                                                      cwd=cwd)
        except CommandExitException as exc:
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
