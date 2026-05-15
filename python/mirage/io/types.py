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
from dataclasses import dataclass, field

from mirage.io.cachable_iterator import CachableAsyncIterator

ByteSource = bytes | AsyncIterator[bytes]


async def materialize(stream: ByteSource | None) -> bytes:
    """Consume a ByteSource and return bytes."""
    if stream is None:
        return b""
    if isinstance(stream, bytes):
        return stream
    if isinstance(stream, CachableAsyncIterator):
        return await stream.drain()
    return b"".join([chunk async for chunk in stream])


@dataclass
class IOResult:
    """Returned by commands to tell workspace how to update cache.

    Args:
        stdout (ByteSource | None): Standard output stream.
        stderr (ByteSource | None): Standard error stream.
        exit_code (int): Process exit code.
        reads (dict[str, ByteSource]): Paths read with content or streams.
        writes (dict[str, ByteSource]): Paths written with content or streams.
        cache (list[str]): Paths worth caching (from reads or writes).
        _stream_source (IOResult | None): Reference to the original IOResult
            that owns the lazy stream. Needed because streaming commands
            (e.g. grep) set exit_code lazily via exit_on_empty — the
            exit_code is only finalized after the stream is consumed.
            When merge() creates a new IOResult, the lazy mutation on
            the original is invisible. _stream_source lets
            sync_exit_code() walk back to the original and pull the
            finalized value after materialization.

            Example flow:
              1. grep returns (exit_on_empty(stream, io_A), io_A)
                 io_A.exit_code = 0 (provisional)
              2. merge() creates io_B with _stream_source = io_A
                 io_B.exit_code = 0 (snapshot)
              3. Stream is consumed → exit_on_empty sets
                 io_A.exit_code = 1
              4. io_B.sync_exit_code() → reads io_A.exit_code = 1 →
                 sets io_B.exit_code = 1
    """

    stdout: ByteSource | None = None
    stderr: ByteSource | None = None
    exit_code: int = 0
    reads: dict[str, ByteSource] = field(default_factory=dict)
    writes: dict[str, ByteSource] = field(default_factory=dict)
    cache: list[str] = field(default_factory=list)
    _stream_source: "IOResult | None" = field(default=None, repr=False)

    def __setattr__(self, name: str, value: object) -> None:
        object.__setattr__(self, name, value)
        # An explicit write to exit_code wins over any lazy _stream_source
        # mirror. Without this, fan-out's aggregated exit code gets
        # clobbered by sync_exit_code() following _stream_source from the
        # last merged sub-IO (issue #43).
        if name == "exit_code" and getattr(self, "_stream_source",
                                           None) is not None:
            object.__setattr__(self, "_stream_source", None)

    async def materialize_stdout(self) -> bytes:
        self.stdout = await materialize(self.stdout)
        return self.stdout

    async def stdout_str(self, errors: str = "replace") -> str:
        return (await self.materialize_stdout()).decode(errors=errors)

    async def materialize_stderr(self) -> bytes:
        self.stderr = await materialize(self.stderr)
        return self.stderr

    async def stderr_str(self, errors: str = "replace") -> str:
        return (await self.materialize_stderr()).decode(errors=errors)

    def sync_exit_code(self) -> None:
        """Pull finalized exit code from the source IOResult.

        Stream wrappers like exit_on_empty lazily set exit_code on
        the original IOResult after consumption. When merge() creates
        a new IOResult, the lazy mutation is invisible. Call this
        after stream materialization to propagate the final value.
        """
        if self._stream_source is not None:
            self._stream_source.sync_exit_code()
            self.exit_code = self._stream_source.exit_code

    async def merge(self, other: "IOResult") -> "IOResult":
        # Fully consume stderr from both sides so it's never lost.
        left_stderr = await materialize(self.stderr)
        right_stderr = await materialize(other.stderr)
        merged_stderr: bytes | None = None
        if left_stderr or right_stderr:
            merged_stderr = left_stderr + right_stderr
        # Sync lazy exit codes (e.g. from exit_on_empty) before
        # snapshotting. Without this, callers that merge before
        # materializing stdout would get a stale exit_code.
        other.sync_exit_code()
        result = IOResult(
            stdout=other.stdout,
            stderr=merged_stderr,
            exit_code=other.exit_code,
            reads={
                **self.reads,
                **other.reads
            },
            writes={
                **self.writes,
                **other.writes
            },
            cache=self.cache + other.cache,
        )
        result._stream_source = other
        return result

    async def merge_aggregate(self, other: "IOResult") -> "IOResult":
        result = await self.merge(other)
        result.exit_code = max(self.exit_code, other.exit_code)
        return result
