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

import shlex
from typing import Any

from mirage.runtime.base import RunResult
from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.constants import STDIN_PATH, sdk_install_hint
from mirage.runtime.sandbox.daytona import sdk
from mirage.runtime.sandbox.daytona.config import DaytonaConfig


class DaytonaRuntime(RemoteSandbox):
    """A Daytona sandbox the user runs as a whole-line runtime.

    You create the sandbox yourself (dashboard, `daytona sandbox
    create`, or the SDK); mirage only connects by ``sandbox_id`` and
    execs lines. ``api_key`` falls back to DAYTONA_API_KEY. Daytona's
    exec has no stdin and reports combined output, so piped bytes are
    uploaded and redirected in, and stderr comes back None. close()
    releases the SDK client and never touches the sandbox.

    Args:
        options (Any): the RemoteSandbox constructor fields.
    """

    name = "daytona"
    config_cls = DaytonaConfig
    config: DaytonaConfig
    _client: Any = None
    _sandbox: Any = None

    async def connect(self) -> None:
        if sdk.AsyncDaytona is None:
            raise ImportError(sdk_install_hint("daytona"))
        if self._client is None:
            api_key = self.config.api_key
            config = (sdk.DaytonaConfig(
                api_key=api_key) if api_key is not None else None)
            self._client = sdk.AsyncDaytona(config)
        self._sandbox = await self._client.get(self.config.sandbox_id)

    async def exec_line(self, line: str, stdin: bytes | None,
                        env: dict[str, str], cwd: str) -> RunResult:
        command = line
        if stdin is not None:
            await self._upload(STDIN_PATH, stdin)
            command = f"( {line} ) < {shlex.quote(STDIN_PATH)}"
        response = await self._sandbox.process.exec(command, cwd=cwd, env=env)
        return RunResult(stdout=str(response.result).encode(),
                         stderr=None,
                         exit_code=int(response.exit_code))

    async def _upload(self, path: str, data: bytes) -> None:
        parent = path.rsplit("/", 1)[0]
        if parent:
            await self._sandbox.fs.create_folder(parent, "755")
        await self._sandbox.fs.upload_file(data, path)

    async def close(self) -> None:
        """Release the SDK client; the sandbox itself is the user's."""
        self._sandbox = None
        if getattr(self, "_client", None) is not None:
            await self._client.close()
            self._client = None
