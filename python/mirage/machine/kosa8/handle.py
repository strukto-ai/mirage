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
import logging
import math
import uuid
from collections.abc import AsyncGenerator, AsyncIterator
from typing import Any, ClassVar

import httpx

from mirage.context.session_context import current_caller
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource
from mirage.machine.constants import (
    PROCESS,
    is_run,
    machine_dir_line,
    not_running_hint,
    run_tag,
    stop_signal,
)
from mirage.machine.errors import ConnectionLostError
from mirage.machine.handle import MachineHandle
from mirage.machine.kosa8.api import (
    ExecFrame,
    Kosa8Api,
    Kosa8ApiError,
    Kosa8StreamCut,
)
from mirage.machine.kosa8.config import Kosa8Config, egress_policy
from mirage.machine.kosa8.constants import (
    EXEC_ARG_CHARS,
    EXEC_ARGS_MAX,
    IDLE_TIMEOUT_SECONDS,
    INPUT_LIMIT_BYTES,
    PRELUDE,
    SANDBOX_GONE,
    STAGED_HEAD,
    START_POLL_SECONDS,
    START_WAIT_SECONDS,
)
from mirage.runtime.types import OutputFn, RunAnswer, RunResult
from mirage.shell.constants import CANNOT_EXECUTE_STATUS
from mirage.types import JsonValue
from mirage.utils.quote import single_quote

logger = logging.getLogger(__name__)


class InputTooLarge(Exception):
    """A line's input ran past the machine's limit."""


def js_length(word: str) -> int:
    """A word's length as kosa8 counts it, in UTF-16 code units.

    Args:
        word (str): one argv entry.
    """
    return len(word.encode("utf-16-le")) // 2


def fits(words: list[str]) -> bool:
    """Whether kosa8 takes ``words`` as one exec's argv.

    Args:
        words (list[str]): the argv.
    """
    return len(words) <= EXEC_ARGS_MAX and all(
        js_length(word) <= EXEC_ARG_CHARS for word in words
    )


async def capped(source: ByteSource, limit: int) -> AsyncIterator[bytes]:
    """``source``'s bytes, failing once they pass ``limit``.

    Args:
        source (ByteSource): a line's input.
        limit (int): the most bytes it may hold.

    Raises:
        InputTooLarge: the input is longer.
    """
    size = 0
    async for part in chunks(source):
        size += len(part)
        if size > limit:
            raise InputTooLarge
        yield part


class Kosa8Machine(MachineHandle):
    """A kosa8 sandbox, a microVM reached through kosa8 Cloud's API.

    Yours, by ``sandbox_id``, or, without one, a sandbox Mirage starts
    from ``template`` or ``image`` at the first run that needs it and
    keeps in the workspace's memory: a later build connects to it again,
    and one that is gone is started anew. kosa8 puts a sandbox Mirage
    started to sleep once nothing has run there for ``idle_timeout``,
    Mirage puts it to sleep as the workspace closes, and the next line
    wakes it; Mirage deletes it as the workspace is deleted. ``api_key``
    falls back to KOSA8_API_KEY and ``api_url`` to KOSA8_CLOUD_URL.

    Each line is one streamed exec. stdout and stderr come back apart,
    byte for byte, as the program writes them. kosa8's exec takes no
    stdin, so a line's input is uploaded to a file in Mirage's folder on
    the sandbox first, which the program reads as its stdin; the program
    starts once its input has ended, and input past
    ``INPUT_LIMIT_BYTES`` fails the line (126). An argv past what one exec
    takes is staged as a script the same way. kosa8 keeps a command
    running when its stream ends, so a cancelled line is stopped by its
    tag. It takes no ``mount_type``: put the files the programs need on the
    sandbox.

    ``network``, ``allowed_domains`` and ``denied_domains`` set the
    sandbox's own network policy, which kosa8 enforces inside the microVM:
    at boot for a sandbox Mirage starts, at connect for one you brought.

    A sandbox you brought is yours: Mirage never deletes it, and puts it
    to sleep only when the workspace pauses and its config says
    ``on_pause: pause`` or the call names it. Once kosa8 says it is gone,
    connecting fails with how to replace it, and a line it cut short
    loses its connection (129) with the same advice; the next line
    connects again.

    Args:
        name (str): the machine's name, its key under ``machines:``.
        config (Kosa8Config | dict[str, Any] | None): how to reach the
            sandbox.
    """

    provider = "kosa8"
    pauses = True
    config_cls = Kosa8Config
    # The most input a line may be given.
    input_limit: ClassVar[int] = INPUT_LIMIT_BYTES
    config: Kosa8Config

    def __init__(
        self, name: str, config: Kosa8Config | dict[str, Any] | None = None
    ) -> None:
        super().__init__(name, config)
        # The sandbox this handle reaches: the config's, or the one Mirage
        # started; None before that.
        self._sandbox_id: str | None = self.config.sandbox_id
        self._api: Kosa8Api | None = None
        # Mirage's folder on the sandbox, by the sandbox it is on.
        self._folder: tuple[str, str] | None = None

    @property
    def instance(self) -> str:
        """The sandbox's id at kosa8; its name before Mirage starts one."""
        return self._sandbox_id if self._sandbox_id is not None else self.name

    def _new_api(self) -> Kosa8Api:
        """A client for kosa8 Cloud; tests substitute a fake transport."""
        return Kosa8Api(self.config.api_key, self.config.api_url)

    def _client(self) -> Kosa8Api:
        if self._api is None:
            self._api = self._new_api()
        return self._api

    def _create_body(self) -> dict[str, JsonValue]:
        """The fields of the create that starts this machine's sandbox."""
        idle = self.config.idle_timeout
        body: dict[str, JsonValue] = {
            "sleep_after_s": math.ceil(
                idle if idle is not None else IDLE_TIMEOUT_SECONDS
            ),
            "labels": {"mirage_machine": self.name},
        }
        if self.config.template is not None:
            body["template"] = self.config.template
        if self.config.image is not None:
            body["image"] = self.config.image
        if (policy := egress_policy(self.config)) is not None:
            body["egress"] = policy
        if self.config.secrets:
            body["secrets"] = list(self.config.secrets)
        return body

    async def connect(self) -> None:
        """Connect to the config's sandbox, setting its network policy
        when the config has one, or to the one Mirage started for this
        workspace, or start one and remember it. A started one that is
        gone is forgotten and started anew; the config's fails with how to
        replace it. A sleeping sandbox wakes on its next line."""
        api = self._client()
        if self.config.sandbox_id is None and self._sandbox_id is None:
            if self._memory is not None:
                self._sandbox_id = await self._memory.recall(self.name)
            self._started_here = self._sandbox_id is not None
        if self._sandbox_id is not None:
            state = await self._state(api, self._sandbox_id)
            if state not in SANDBOX_GONE:
                policy = egress_policy(self.config)
                if self.config.sandbox_id is not None and policy is not None:
                    await api.set_egress(self._sandbox_id, policy)
                self._reached = True
                return
            hint = not_running_hint(
                "sandbox", self._sandbox_id, state, SANDBOX_GONE
            )
            if not self._started_here:
                raise RuntimeError(hint)
            if self._memory is not None:
                await self._memory.forget(self.name)
            self._sandbox_id = None
        sandbox = await api.create(self._create_body())
        self._sandbox_id = str(sandbox["id"])
        self._started_here = True
        try:
            if self._memory is not None:
                await self._memory.remember(self.name, self._sandbox_id)
            await self._until_running(api, sandbox)
        except BaseException:
            await self._drop_unkept(api)
            raise
        self._reached = True

    @staticmethod
    async def _state(api: Kosa8Api, sandbox_id: str) -> str:
        """The sandbox's state at kosa8; ``deleted`` when it has none.

        Args:
            api (Kosa8Api): the client.
            sandbox_id (str): the sandbox.
        """
        try:
            sandbox = await api.get(sandbox_id)
        except Kosa8ApiError as exc:
            if exc.status == 404:
                return "deleted"
            raise
        return str(sandbox.get("state"))

    async def _until_running(
        self, api: Kosa8Api, sandbox: dict[str, JsonValue]
    ) -> None:
        """Wait for a sandbox Mirage just started to run: one booted from
        an image is still creating when the create answers.

        Args:
            api (Kosa8Api): the client.
            sandbox (dict[str, JsonValue]): the sandbox the create
                answered.

        Raises:
            RuntimeError: it failed to start, or did not start in time.
        """
        async with asyncio.timeout(START_WAIT_SECONDS):
            while (state := str(sandbox.get("state"))) == "creating":
                await asyncio.sleep(START_POLL_SECONDS)
                sandbox = await api.get(str(sandbox["id"]))
        if state in SANDBOX_GONE:
            why = sandbox.get("last_error") or state
            raise RuntimeError(
                f"kosa8: sandbox {sandbox['id']} did not start: {why}"
            )

    async def _drop_unkept(self, api: Kosa8Api) -> None:
        """Delete a sandbox just started that the workspace could not keep
        or that never ran, so it does not outlive the workspace unseen; the
        next connect starts another.

        Args:
            api (Kosa8Api): the client.
        """
        sandbox_id, self._sandbox_id = self._sandbox_id, None
        self._started_here = False
        if sandbox_id is None:
            return
        try:
            await asyncio.shield(api.delete(sandbox_id))
            if self._memory is not None:
                await self._memory.forget(self.name)
        except Exception:
            logger.warning(
                "%s: sandbox %s Mirage started could not be deleted",
                self.machine,
                sandbox_id,
                exc_info=True,
            )

    async def destroy(self) -> None:
        """Delete the sandbox Mirage started for this workspace, as the
        workspace is deleted, and forget it; one the config names stays.
        Reaches the one the workspace remembers when this build never
        connected."""
        if self.config.sandbox_id is not None:
            await self._release_mounts()
            return
        sandbox_id = self._sandbox_id
        if sandbox_id is None and self._memory is not None:
            sandbox_id = await self._memory.recall(self.name)
        if sandbox_id is None:
            return
        api = self._new_api()
        try:
            await api.delete(sandbox_id)
        except Kosa8ApiError as exc:
            if exc.status != 404:
                raise
        finally:
            await api.close()
        if self._memory is not None:
            await self._memory.forget(self.name)
        self._sandbox_id = None
        self._started_here = False

    def config_asks_to_pause(self) -> bool:
        """Whether the config says ``on_pause: pause``."""
        return self.config.on_pause == "pause"

    async def _pause_machine(self) -> None:
        """Put the sandbox to sleep, its memory and disk kept, through a
        client of its own: close released the workspace's. The next line
        wakes it. One already gone or asleep has nothing to do."""
        if self._sandbox_id is None:
            return
        api = self._new_api()
        try:
            await api.sleep(self._sandbox_id)
        except Kosa8ApiError as exc:
            if exc.status not in (404, 409):
                raise
            logger.debug(
                "%s: sandbox not running, nothing to put to sleep",
                self.machine,
                exc_info=True,
            )
        finally:
            await api.close()

    def _lost(self, exc: BaseException) -> ConnectionLostError | None:
        """The lost connection ``exc`` is when the sandbox went or kosa8
        could not be reached, which also lets the next line connect again;
        None otherwise. Its message is the hint the line says.

        Args:
            exc (BaseException): what a call to kosa8 raised.
        """
        if isinstance(exc, Kosa8ApiError) and exc.status in (404, 409):
            state = "deleted" if exc.status == 404 else "stopped"
            hint = not_running_hint(
                "sandbox", self.instance, state, SANDBOX_GONE
            )
        elif isinstance(exc, Kosa8ApiError) and exc.status in (502, 503):
            hint = str(exc)
        elif isinstance(exc, (httpx.TransportError, Kosa8StreamCut)):
            hint = f"kosa8 could not be reached: {exc}"
        else:
            return None
        self._disconnected()
        return ConnectionLostError(hint)

    async def _machine_folder(self, api: Kosa8Api, sandbox_id: str) -> str:
        """Mirage's own folder on the sandbox (``machine_dir_line``), made
        if need be and asked once per sandbox.

        Args:
            api (Kosa8Api): the client.
            sandbox_id (str): the sandbox.
        """
        if self._folder is not None and self._folder[0] == sandbox_id:
            return self._folder[1]
        line = machine_dir_line(()) + 'printf %s "$d"'
        out = bytearray()
        err = bytearray()
        async for frame in api.exec(sandbox_id, ("/bin/sh", "-c", line), ()):
            (err if frame.stream == "stderr" else out).extend(frame.data)
            if frame.exit_code not in (None, 0):
                raise RuntimeError(err.decode(errors="replace").strip())
        self._folder = (sandbox_id, out.decode())
        return self._folder[1]

    async def _stage(
        self, api: Kosa8Api, sandbox_id: str, kind: str, data: ByteSource
    ) -> str:
        """Upload ``data`` to a new file in Mirage's folder on the sandbox
        and return its path.

        Args:
            api (Kosa8Api): the client.
            sandbox_id (str): the sandbox.
            kind (str): what the file holds, the start of its name.
            data (ByteSource): its bytes.
        """
        folder = await self._machine_folder(api, sandbox_id)
        path = f"{folder}/{kind}-{uuid.uuid4().hex}"
        try:
            await api.upload(sandbox_id, path, capped(data, self.input_limit))
        except BaseException:
            await asyncio.shield(self._unstage(api, sandbox_id, [path]))
            raise
        return path

    async def _unstage(
        self, api: Kosa8Api, sandbox_id: str, paths: list[str]
    ) -> None:
        """Remove staged files a line that never started left behind.

        Args:
            api (Kosa8Api): the client.
            sandbox_id (str): the sandbox.
            paths (list[str]): the files.
        """
        for path in paths:
            try:
                await api.remove(sandbox_id, path)
            except Exception:
                logger.debug(
                    "%s: staged %s not removed",
                    self.machine,
                    path,
                    exc_info=True,
                )

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn,
        errors: OutputFn,
    ) -> RunResult:
        api = self._client()
        sandbox_id = self._sandbox_id
        if sandbox_id is None:
            raise RuntimeError("kosa8 machine not connected")
        staged: list[str] = []
        started = False
        frames: AsyncGenerator[ExecFrame, None] | None = None
        try:
            source = ""
            if stdin is not None and stdin != b"":
                source = await self._stage(api, sandbox_id, "in", stdin)
                staged.append(source)
            words = [
                "/bin/sh",
                "-c",
                PRELUDE,
                "sh",
                source,
                cwd,
                "env",
                *(f"{key}={value}" for key, value in env.items()),
                *argv,
            ]
            if not fits(words):
                script = STAGED_HEAD + " ".join(map(single_quote, words))
                path = await self._stage(
                    api, sandbox_id, "run", script.encode()
                )
                staged.append(path)
                words = ["/bin/sh", path]
            frames = api.exec(sandbox_id, words, ())
            exit_code = -1
            async for frame in frames:
                started = True
                if frame.exit_code is not None:
                    exit_code = frame.exit_code
                elif frame.stream == "stderr":
                    await errors(frame.data)
                else:
                    await output(frame.data)
        except InputTooLarge:
            await errors(
                f"mirage: {self.machine}: input past "
                f"{self.input_limit} bytes; kosa8 takes a line's input "
                "whole\n".encode()
            )
            return RunResult(exit_code=CANNOT_EXECUTE_STATUS)
        except BaseException as exc:
            if frames is not None:
                await frames.aclose()
            if not started and staged:
                await asyncio.shield(self._unstage(api, sandbox_id, staged))
            lost = self._lost(exc)
            if lost is not None:
                await errors(f"kosa8: {lost}\n".encode())
                raise lost from exc
            # kosa8 keeps the command once its stream ends: a run a kill
            # stopped with a gentler signal gets that signal first, and the
            # caller stops a cancel.
            tag = run_tag(argv) if is_run(argv) else env.get(PROCESS)
            signum = stop_signal(current_caller().process)
            if tag is not None and signum is not None:
                await asyncio.shield(self.stop(tag, signum))
            if tag is not None and not isinstance(exc, asyncio.CancelledError):
                await self.stop(tag, 15)
            raise
        return RunResult(exit_code=exit_code)

    async def exec_line(
        self,
        line: str,
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        *,
        bounded: bool = False,
    ) -> RunAnswer:
        """Execute one shell line, under a ``PROCESS`` tag of its own
        when the caller gave none: kosa8 keeps a command its stream left,
        so a cancelled line is stopped by that tag.

        Args:
            line (str): the raw shell line.
            stdin (ByteSource | None): bytes piped into the line.
            env (dict[str, str]): the merged environment.
            cwd (str): the working directory, passed through verbatim.
            bounded (bool): hold what it keeps to the workspace's memory
                room, for a line that reads a file's content.
        """
        if PROCESS in env:
            return await super().exec_line(
                line, stdin, env, cwd, bounded=bounded
            )
        tag = uuid.uuid4().hex
        try:
            return await super().exec_line(
                line, stdin, {**env, PROCESS: tag}, cwd, bounded=bounded
            )
        except asyncio.CancelledError:
            await asyncio.shield(self.stop(tag, 15))
            raise

    async def close(self) -> None:
        """Release the API client once a connect under way has settled;
        the sandbox stays."""
        try:
            await super().close()
        finally:
            if self._api is not None:
                api, self._api = self._api, None
                await api.close()
