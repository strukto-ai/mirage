import asyncio
import base64
import json
import os
import stat
import sys
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable
from typing import Any

import aiohttp

from mirage.cli.client import DaemonClient
from mirage.cli.output import exit_code_from_response
from mirage.io.cooperative import CHUNK_SIZE
from mirage.types import Refusal
from mirage.workspace.tools.io_text import SaidWindow

MAX_RECORD_BYTES = 1024 * 1024


async def _ready(fd: int, writing: bool) -> None:
    loop = asyncio.get_running_loop()
    ready = loop.create_future()

    def wake() -> None:
        if not ready.done():
            ready.set_result(None)

    if writing:
        loop.add_writer(fd, wake)
    else:
        loop.add_reader(fd, wake)
    try:
        await ready
    finally:
        if writing:
            loop.remove_writer(fd)
        else:
            loop.remove_reader(fd)


async def _stdin_chunks() -> AsyncIterator[bytes]:
    fd = sys.stdin.fileno()
    regular = stat.S_ISREG(os.fstat(fd).st_mode)
    blocking = os.get_blocking(fd)
    os.set_blocking(fd, False)
    try:
        while True:
            try:
                data = (
                    await asyncio.to_thread(os.read, fd, CHUNK_SIZE)
                    if regular
                    else os.read(fd, CHUNK_SIZE)
                )
            except BlockingIOError:
                await _ready(fd, False)
                continue
            if not data:
                return
            yield data
    finally:
        os.set_blocking(fd, blocking)


async def _write(fd: int, data: bytes) -> None:
    regular = stat.S_ISREG(os.fstat(fd).st_mode)
    blocking = os.get_blocking(fd)
    os.set_blocking(fd, False)
    try:
        rest = memoryview(data)
        while rest:
            try:
                written = (
                    await asyncio.to_thread(os.write, fd, rest)
                    if regular
                    else os.write(fd, rest)
                )
            except BlockingIOError:
                await _ready(fd, True)
                continue
            rest = rest[written:]
    finally:
        os.set_blocking(fd, blocking)


async def consume_stream(
    source: AsyncIterable[bytes],
    stdout: Callable[[bytes], Awaitable[None]],
    stderr: Callable[[bytes], Awaitable[None]],
) -> dict[str, Any]:
    """Decode bounded NDJSON records and await each output write.

    Args:
        source (AsyncIterable[bytes]): The daemon's response body.
        stdout (Callable): The asynchronous stdout writer.
        stderr (Callable): The asynchronous stderr writer.
    """
    pending = bytearray()
    terminal: dict[str, Any] | None = None
    async for chunk in source:
        pending.extend(chunk)
        while b"\n" in pending:
            line, _, rest = pending.partition(b"\n")
            pending = bytearray(rest)
            if len(line) > MAX_RECORD_BYTES:
                raise ValueError("daemon stream record is too large")
            record = json.loads(line)
            if not isinstance(record, dict) or terminal is not None:
                raise ValueError("invalid daemon stream record")
            stream = record.get("stream")
            if stream in ("stdout", "stderr"):
                data = record.get("data")
                if not isinstance(data, str):
                    raise ValueError("invalid daemon stream bytes")
                raw = base64.b64decode(data, validate=True)
                if base64.b64encode(raw).decode("ascii") != data:
                    raise ValueError("invalid daemon stream bytes")
                await (stdout(raw) if stream == "stdout" else stderr(raw))
            elif record.get("status") in ("done", "failed", "canceled"):
                if "result" not in record or "error" not in record:
                    raise ValueError("invalid daemon stream completion")
                if record["result"] is not None and not isinstance(
                    record["result"], dict
                ):
                    raise ValueError("invalid daemon stream completion")
                if record["error"] is not None and not isinstance(
                    record["error"], str
                ):
                    raise ValueError("invalid daemon stream completion")
                terminal = record
            else:
                raise ValueError("invalid daemon stream record")
        if len(pending) > MAX_RECORD_BYTES:
            raise ValueError("daemon stream record is too large")
    if pending or terminal is None:
        raise ValueError("daemon stream ended without a completion record")
    return terminal


def refusal_of(result: dict[str, Any] | None) -> Refusal | None:
    """The refusal record off a completion's result.

    Args:
        result (dict[str, Any] | None): the completion's result.
    """
    refusal = (result or {}).get("refusal")
    return Refusal(**refusal) if isinstance(refusal, dict) else None


async def stream_shell(
    client: DaemonClient,
    path: str,
    payload: dict[str, Any],
    piped: bool,
    *,
    json_output: bool = False,
) -> int:
    """Run a shell line while uploading stdin and draining output together.

    When a policy refused part of the line, its reason follows the output
    as one line on stderr, as the SSH door prints it.

    Args:
        client (DaemonClient): The configured daemon client.
        path (str): The shell endpoint, including query parameters.
        payload (dict): The shell request.
        piped (bool): Whether to stream standard input.
        json_output (bool): Collect bytes into one JSON result at completion.
    """
    token = client.token()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    body = None
    if piped:
        body = aiohttp.FormData()
        body.add_field(
            "request",
            json.dumps(payload),
            filename="request.json",
            content_type="application/json",
        )
        body.add_field(
            "stdin",
            _stdin_chunks(),
            filename="stdin.bin",
            content_type="application/octet-stream",
        )

    stdout_fd = sys.stdout.fileno()
    stderr_fd = sys.stderr.fileno()

    captured_stdout = bytearray()
    captured_stderr = bytearray()
    said = SaidWindow()

    async def stdout(data: bytes) -> None:
        if json_output:
            captured_stdout.extend(data)
        else:
            said.add(data, False)
            await _write(stdout_fd, data)

    async def stderr(data: bytes) -> None:
        if json_output:
            captured_stderr.extend(data)
        else:
            said.add(data, True)
            await _write(stderr_fd, data)

    try:
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=None),
            headers=headers,
        ) as session:
            async with session.post(
                client.settings.url.rstrip("/") + path,
                data=body,
                json=payload if body is None else None,
            ) as response:
                if response.status == 499:
                    return 130
                if response.status >= 400:
                    detail = await response.text()
                    raise RuntimeError(
                        f"daemon error {response.status}: {detail}"
                    )
                terminal = await consume_stream(
                    response.content.iter_chunked(CHUNK_SIZE), stdout, stderr
                )
    except aiohttp.ClientError as exc:
        raise RuntimeError(f"daemon stream failed: {exc}") from exc
    if terminal["status"] == "failed":
        raise RuntimeError(f"shell failed: {terminal['error']}")
    if terminal["status"] == "canceled":
        return 130
    line = (
        ""
        if json_output
        else said.refusal_line(refusal_of(terminal["result"]))
    )
    if line:
        await _write(stderr_fd, line.encode())
    if json_output:
        result = {
            **(terminal["result"] or {}),
            "stdout": captured_stdout.decode(errors="replace"),
            "stderr": captured_stderr.decode(errors="replace"),
        }
        await _write(
            stdout_fd,
            (json.dumps(result, indent=2, ensure_ascii=False) + "\n").encode(),
        )
    return exit_code_from_response(terminal["result"])
