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

import logging
from typing import Any

from mirage.io.types import ByteSource
from mirage.machine.constants import (
    decode_output,
    encode_output,
    wrap_line,
)
from mirage.machine.daytona import sdk
from mirage.machine.daytona.config import DaytonaConfig
from mirage.machine.daytona.constants import PAUSED_STATE
from mirage.machine.handle import MachineHandle
from mirage.runtime.constants import sdk_install_hint
from mirage.runtime.types import OutputFn, RunAnswer, RunResult

logger = logging.getLogger(__name__)


class DaytonaMachine(MachineHandle):
    """A running Daytona sandbox, reached through its SDK.

    You create the sandbox yourself (dashboard, `daytona sandbox
    create`, or the SDK); mirage only connects by ``sandbox_id`` and
    execs lines. ``api_key`` falls back to DAYTONA_API_KEY. Daytona's
    exec takes no stdin and reports combined output once the command
    ends, so a run given input is refused (126) before it starts, and
    the joined answer is written once through the run's stdout at the
    end (``joins_streams``). The output is
    base64-encoded in the sandbox, since the exec returns it as text
    (``encode_output``: the sandbox needs dd and base64). close()
    releases the SDK client and never touches the sandbox. Mirage pauses
    the sandbox only when the workspace pauses and its config says
    ``on_pause: pause`` or the call names it, and the next connect starts
    it again.

    Args:
        name (str): the machine's name, its key under ``machines:``.
        config (DaytonaConfig | dict[str, Any] | None): how to reach the sandbox.
    """

    provider = "daytona"
    pauses = True
    takes_input = False
    joins_streams = True
    config_cls = DaytonaConfig
    config: DaytonaConfig

    _client: Any = None
    _sandbox: Any = None

    @property
    def instance(self) -> str:
        """The sandbox's id at Daytona."""
        return self.config.sandbox_id

    def _new_client(self) -> Any:
        api_key = self.config.api_key
        config = (
            sdk.DaytonaConfig(api_key=api_key) if api_key is not None else None
        )
        return sdk.AsyncDaytona(config)

    async def connect(self) -> None:
        if sdk.AsyncDaytona is None:
            raise ImportError(sdk_install_hint("daytona"))
        if self._client is None:
            self._client = self._new_client()
        self._sandbox = await self._client.get(self.config.sandbox_id)
        if self._sandbox.state == PAUSED_STATE:
            await self._sandbox.start()
        self._reached = True

    def config_asks_to_pause(self) -> bool:
        """Whether the config says ``on_pause: pause``."""
        return self.config.on_pause == "pause"

    async def _pause_machine(self) -> None:
        """Pause the sandbox, keeping its disk and memory, through a client
        of its own: close released the workspace's. Daytona pauses only VM
        sandboxes, and refuses any other. A sandbox already gone has
        nothing to pause."""
        client = self._new_client()
        try:
            sandbox = await client.get(self.config.sandbox_id)
            await sandbox.pause()
        except sdk.DaytonaNotFoundError:
            logger.debug(
                "%s: sandbox already gone, nothing to pause",
                self.machine,
                exc_info=True,
            )
        finally:
            await client.close()

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn,
        errors: OutputFn,
    ) -> RunResult:
        if stdin is not None and stdin != b"":
            return await self.input_refused(errors)
        command = encode_output(wrap_line(argv, env, cwd), combined=True)
        response = await self._sandbox.process.exec(command)
        if answer := decode_output(str(response.result)):
            await output(answer)
        return RunResult(exit_code=int(response.exit_code))

    async def put_file(self, path: str, data: bytes) -> RunAnswer:
        """Write a file through Daytona's file API, since its exec takes
        no input.

        Args:
            path (str): the file's path in the sandbox.
            data (bytes): its new bytes.
        """
        await self.ensure_connected()
        await self._sandbox.fs.upload_file(data, path)
        return RunAnswer(0)

    async def close(self) -> None:
        """Release the SDK client once a connect under way has settled; the
        sandbox itself is the user's."""
        try:
            await super().close()
        finally:
            self._sandbox = None
            if self._client is not None:
                await self._client.close()
                self._client = None
