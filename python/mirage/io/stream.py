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

from collections.abc import AsyncIterator

from mirage.io import CachableAsyncIterator, IOResult
from mirage.io.types import ByteSource, materialize


async def merge_stdout_stderr(
    stdout: ByteSource | None,
    io: IOResult,
) -> AsyncIterator[bytes]:
    """Stream stdout chunks with stderr prepended (for `cmd 2>&1 | next`).

    Emits stderr first (was conceptually produced before/around stdout
    output), then streams stdout chunk-by-chunk without materializing.
    Clears io.stderr after consumption so the pipeline's stderr
    accumulator does not double-emit it.
    """
    stderr_bytes = await materialize(io.stderr)
    if stderr_bytes:
        yield stderr_bytes
    io.stderr = None
    if stdout is None:
        return
    if isinstance(stdout, bytes):
        if stdout:
            yield stdout
        return
    async for chunk in stdout:
        yield chunk


def wrap_cachable_streams(
    stdout: ByteSource | None,
    io: IOResult,
) -> tuple[ByteSource | None, IOResult]:
    for path in io.cache:
        stream = io.reads.get(path) or io.writes.get(path)
        if stream is not None and not isinstance(
                stream, (bytes, CachableAsyncIterator)):
            ci = CachableAsyncIterator(stream)
            if path in io.reads:
                io.reads[path] = ci
            elif path in io.writes:
                io.writes[path] = ci
            if stdout is stream:
                stdout = ci
    return stdout, io


async def exit_on_empty(
    stream: AsyncIterator[bytes],
    io: IOResult,
) -> AsyncIterator[bytes]:
    yielded = False
    async for chunk in stream:
        yielded = True
        yield chunk
    if not yielded:
        io.exit_code = 1


async def drain(stream: ByteSource | None) -> None:
    if stream is None or isinstance(stream, bytes):
        return
    if isinstance(stream, CachableAsyncIterator):
        await stream.drain()
        return
    async for _ in stream:
        pass


async def close_quietly(stream: ByteSource | None) -> None:
    """Best-effort close on an async generator stream.

    Calls the underlying Python `aclose()` protocol. Ensures resource
    cleanup (HTTP connections, file handles) fires promptly instead of
    waiting for GC. Harmless on exhausted streams and on bytes/None.
    """
    if stream is None or isinstance(stream, bytes):
        return
    closer = getattr(stream, "aclose", None)
    if closer is None:
        return
    try:
        await closer()
    except Exception:
        pass


async def async_chain(*streams: ByteSource | None, ) -> AsyncIterator[bytes]:
    for stream in streams:
        if stream is None:
            continue
        if isinstance(stream, bytes):
            if stream:
                yield stream
        else:
            async for chunk in stream:
                yield chunk


async def chain_cachables(
        *iters: CachableAsyncIterator) -> AsyncIterator[bytes]:
    """Chain cachable iterators, replaying already-buffered chunks.

    Pulls each iterator live so a downstream early exit (e.g. head)
    stops the walk without opening later files. If apply_io drained an
    iterator for caching first, its buffered chunks are replayed
    instead of being lost.

    Args:
        iters (CachableAsyncIterator): Per-file cachable iterators in
            output order.

    Yields:
        bytes: Chunks of each iterator in order.
    """
    for it in iters:
        idx = 0
        while True:
            buf = it.buffered_chunks
            while idx < len(buf):
                chunk = buf[idx]
                idx += 1
                yield chunk
            if it.exhausted:
                break
            try:
                await it.__anext__()
            except StopAsyncIteration:
                break


async def yield_bytes(data: bytes) -> AsyncIterator[bytes]:
    yield data


async def quiet_match(
    stream: AsyncIterator[bytes],
    io: IOResult,
) -> AsyncIterator[bytes]:
    async for _ in stream:
        io.exit_code = 0
        return
    io.exit_code = 1
    return
    yield b""
