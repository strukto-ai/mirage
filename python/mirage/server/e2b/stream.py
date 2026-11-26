import asyncio
import base64
import logging
from collections.abc import AsyncGenerator
from contextlib import aclosing
from itertools import count

from fastapi import Response
from starlette.requests import ClientDisconnect
from starlette.types import Message, Receive, Scope, Send

from mirage.concurrency.limiter import owned_task, settle
from mirage.io.pipe import BytePipe
from mirage.server.e2b import constants
from mirage.server.e2b.connect import StartCommand, encode_message, end_stream
from mirage.server.e2b.sandbox import LiveProcess, Sandbox
from mirage.server.errors import INTERNAL_MESSAGE
from mirage.utils.abort import ABORT_JOIN_SECONDS, MirageAbortError

logger = logging.getLogger(__name__)

_process_ids = count(1)


async def _open_process(
    lease: Sandbox, command: StartCommand
) -> tuple[int, LiveProcess]:
    if (
        not lease.entry.accepting_jobs
        or lease.expires_at <= asyncio.get_running_loop().time()
    ):
        raise MirageAbortError()
    stdin = BytePipe() if command.stdin else None
    execution = await lease.entry.runner.ws.shell(
        command.line,
        session_id=lease.session_id,
        cwd=command.cwd if command.cwd is not None else constants.HOME,
        env={**lease.env_vars, **command.envs},
        stdin=stdin.stream() if stdin is not None else None,
        stream=True,
    )
    pid = (next(_process_ids) - 1) % 0xFFFFFFFF + 1
    while pid in lease.processes:
        pid = (next(_process_ids) - 1) % 0xFFFFFFFF + 1
    process = LiveProcess(command, execution, stdin)
    lease.processes[pid] = process

    def release() -> None:
        del lease.processes[pid]
        process.stop_input()

    execution.on_settled(release)
    return pid, process


async def _close_process(process: LiveProcess) -> None:
    process.execution.cancel()
    process.stop_input()
    await process.execution.aclose()


async def _events(
    lease: Sandbox, command: StartCommand
) -> AsyncGenerator[bytes, None]:
    if (
        not lease.entry.accepting_jobs
        or lease.expires_at <= asyncio.get_running_loop().time()
    ):
        raise MirageAbortError()
    runner = lease.entry.runner
    opening = asyncio.create_task(runner.call(_open_process(lease, command)))
    try:
        pid, process = await asyncio.shield(opening)
        yield encode_message({"start": {"pid": pid}})
        try:
            while (
                event := await runner.call(
                    anext(process.execution.events, None)
                )
            ) is not None:
                yield encode_message(
                    {
                        "data": {
                            event.stream: base64.b64encode(event.data).decode(
                                "ascii"
                            )
                        }
                    }
                )
            result = await runner.call(process.execution.wait())
            exit_code, status = result.exit_code, "exited"
        except MirageAbortError:
            if not process.killed:
                raise
            exit_code, status = 137, "signal: killed"
        yield encode_message(
            {
                "end": {
                    "exitCode": exit_code,
                    "exited": True,
                    "status": status,
                }
            }
        )
    finally:
        # Opening keeps its result until both sides have handed it over,
        # even when the client leaves at the same time.
        try:
            _, process = await settle(opening)
        except Exception:
            logger.debug("opening sandbox command failed", exc_info=True)
        else:
            try:
                await settle(owned_task(runner.call(_close_process(process))))
            except RuntimeError:
                if lease.entry.accepting_jobs:
                    raise
                logger.debug("sandbox closed with its command", exc_info=True)


async def _disconnect(receive: Receive) -> None:
    while (await receive())["type"] != "http.disconnect":
        pass


class ProcessResponse(Response):
    """Stream one command until it finishes or its client or lease leaves."""

    def __init__(
        self, lease: Sandbox, command: StartCommand, deadline: float | None
    ) -> None:
        super().__init__(media_type=constants.CONNECT_STREAM)
        del self.headers["content-length"]
        self._lease = lease
        self._command = command
        self._deadline = deadline

    async def _send(self, send: Send) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": self.status_code,
                "headers": self.raw_headers,
            }
        )
        terminal = end_stream()
        timeout = asyncio.timeout_at(self._deadline)
        try:
            async with (
                timeout,
                aclosing(_events(self._lease, self._command)) as events,
            ):
                async for frame in events:
                    await send(
                        {
                            "type": "http.response.body",
                            "body": frame,
                            "more_body": True,
                        }
                    )
        except TimeoutError:
            if timeout.expired():
                terminal = end_stream(
                    "deadline_exceeded", constants.DEADLINE_MESSAGE
                )
            else:
                logger.exception("sandbox command raised a timeout")
                terminal = end_stream("internal", INTERNAL_MESSAGE)
        except ClientDisconnect:
            raise
        except MirageAbortError:
            terminal = end_stream("canceled", "command canceled")
        except Exception:
            if self._lease.entry.accepting_jobs:
                logger.exception("sandbox command failed")
                terminal = end_stream("internal", INTERNAL_MESSAGE)
            else:
                terminal = end_stream("canceled", "sandbox closed")
        await send(
            {
                "type": "http.response.body",
                "body": terminal,
                "more_body": False,
            }
        )

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        async def connected(message: Message) -> None:
            try:
                await send(message)
            except OSError as exc:
                raise ClientDisconnect() from exc

        sender = asyncio.create_task(self._send(connected))
        disconnected = asyncio.create_task(_disconnect(receive))
        revoked = asyncio.create_task(self._lease.revoked.wait())
        connection = {sender, disconnected}
        tasks = (*connection, revoked)
        try:
            done, _ = await asyncio.wait(
                tasks, return_when=asyncio.FIRST_COMPLETED
            )
            if done == {revoked}:
                done, _ = await asyncio.wait(
                    connection,
                    timeout=ABORT_JOIN_SECONDS,
                    return_when=asyncio.FIRST_COMPLETED,
                )
            for task in done:
                await task
        except ClientDisconnect:
            logger.debug("sandbox command connection closed", exc_info=True)
        finally:
            for task in tasks:
                task.cancel()
            for result in await settle(
                asyncio.gather(*tasks, return_exceptions=True)
            ):
                if isinstance(result, Exception):
                    logger.debug(
                        "sandbox command transport closed: %r", result
                    )
