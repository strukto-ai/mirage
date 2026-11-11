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

import hashlib

import pytest

from mirage.commands.builtin.generic.checksum import (
    ChecksumFlags,
    checksum_generic,
)
from mirage.commands.config import Context
from mirage.io.memory import MemoryBudget, run_with_memory
from mirage.io.types import materialize
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import OpenStream
from mirage.types import FileStat, FileType, PathSpec

_DIGEST = hashlib.md5(b"abc").hexdigest()


def _spec(path: str) -> PathSpec:
    return PathSpec(
        virtual=path, directory=path, vfs_path=path.lstrip("/"), raw_path=path
    )


def _fs(files: dict[str, str]):
    async def read_stream(p: PathSpec):
        assert isinstance(p, PathSpec)
        if p.virtual not in files:
            raise FileNotFoundError(p.virtual)
        yield files[p.virtual].encode()

    return read_stream


async def _a_file(p: PathSpec) -> FileStat:
    return FileStat(name=p.virtual, type=FileType.FILE)


async def _checksum(paths, stream, stored=None, **flags):
    return await checksum_generic(
        ChecksumFlags(**flags),
        paths,
        [],
        Context(),
        _a_file,
        stream,
        name="md5sum",
        stored=stored,
    )


async def _run_check(
    files: dict[str, str], paths: list[str] | None = None, **flags: bool
) -> tuple[str, str, int]:
    out, io = await _checksum(
        [_spec(p) for p in (paths or ["/sums.txt"])],
        _fs(files),
        check=True,
        **flags,
    )
    stdout = out.decode() if isinstance(out, bytes) else ""
    stderr = io.stderr.decode() if io.stderr else ""
    return stdout, stderr, io.exit_code


# GNU coreutils 9.7, pinned on debian:stable-slim: the per-file strerror
# lines and the WARNING block are stderr, FAILED lines are stdout, and
# --status silences everything except the strerror lines.


_MISSING_ONE = {
    "/sums.txt": f"{_DIGEST}  /ok.txt\n{_DIGEST}  /miss.txt\n",
    "/ok.txt": "abc",
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("flags", "expected"),
    [
        (
            {},
            (
                "/ok.txt: OK\n/miss.txt: FAILED open or read\n",
                "md5sum: /miss.txt: No such file or directory\n"
                "md5sum: WARNING: 1 listed file could not be read\n",
                1,
            ),
        ),
        (
            {"status": True},
            ("", "md5sum: /miss.txt: No such file or directory\n", 1),
        ),
    ],
)
async def test_check_reports_a_missing_recorded_file(flags, expected):
    assert await _run_check(_MISSING_ONE, **flags) == expected


@pytest.mark.asyncio
async def test_a_list_line_too_long_to_hold_is_that_lists_read_error(
    monkeypatch,
):
    # The digest engine refuses a list line past its cap. Out of memory,
    # md5sum says the list's read error, prints none of its summaries and
    # goes on to the next list (pinned, coreutils 9.7).
    feed = OpenStream.feed

    def refusing(self: OpenStream, chunk: bytes) -> bytes:
        if chunk == b"long":
            raise StreamRefusal("read error", b"")
        return feed(self, chunk)

    monkeypatch.setattr(OpenStream, "feed", refusing)
    files = {**_MISSING_ONE, "/sums.txt": f"{_DIGEST}  /ok.txt\n"}
    files["/long.txt"] = "long"
    paths = ["/sums.txt", "/long.txt", "/sums.txt"]
    assert await _run_check(files, paths=paths) == (
        "/ok.txt: OK\n/ok.txt: OK\n",
        "md5sum: /long.txt: read error\n",
        1,
    )


@pytest.mark.asyncio
async def test_non_fs_read_failure_propagates():
    async def stream(p: PathSpec):
        if p.virtual == "/f.txt":
            raise RuntimeError("S3 GET f failed: 403 Forbidden")
        yield b"5aabc000000000000000000000000000  /f.txt\n"

    with pytest.raises(RuntimeError, match="403 Forbidden"):
        await _checksum([_spec("/sums.txt")], stream, check=True)


@pytest.mark.asyncio
async def test_a_stored_digest_stands_in_for_the_read():
    reads: list[str] = []
    asked: list[tuple[str, str]] = []

    async def read_stream(p: PathSpec):
        reads.append(p.virtual)
        yield b"abc"

    async def stored(p: PathSpec, algorithm: str) -> str | None:
        asked.append((p.virtual, algorithm))
        return "f" * 32 if p.virtual == "/a" else None

    out, io = await _checksum([_spec("/a"), _spec("/b")], read_stream, stored)
    got = b"".join([chunk async for chunk in out])
    assert got == f"{'f' * 32}  /a\n{_DIGEST}  /b\n".encode()
    assert asked == [("/a", "md5"), ("/b", "md5")]
    assert reads == ["/b"]


async def _never_stored(p: PathSpec, algorithm: str) -> str | None:
    raise AssertionError("asked a stored digest under -c")


async def _stored_but_b(p: PathSpec, algorithm: str) -> str | None:
    if p.virtual == "/b":
        raise FileNotFoundError(2, "No such file or directory", "/b")
    return "f" * 32


@pytest.mark.asyncio
async def test_check_reads_the_bytes_and_asks_no_stored_digest():
    read_stream = _fs({"/list": f"{_DIGEST}  /f\n", "/f": "abc"})
    out, io = await _checksum(
        [_spec("/list")], read_stream, _never_stored, check=True
    )
    assert (out, io.exit_code) == (b"/f: OK\n", 0)


@pytest.mark.asyncio
async def test_a_failed_stored_digest_is_reported_and_the_rest_hash():
    out, io = await _checksum(
        [_spec("/a"), _spec("/b"), _spec("/c")], _fs({}), _stored_but_b
    )
    got = b"".join([chunk async for chunk in out])
    assert got == f"{'f' * 32}  /a\n{'f' * 32}  /c\n".encode()
    assert io.exit_code == 1
    assert io.stderr == b"md5sum: /b: No such file or directory\n"


@pytest.mark.asyncio
async def test_check_list_larger_than_the_memory_budget_is_streamed():
    chunk = b" " * 16383 + b"\n"

    async def stream(path):
        if path.virtual == "/f":
            yield b"x"
            return
        for _ in range(2176):
            yield chunk
        yield b"2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881  /f\n"

    async def run():
        out, io = await _checksum(
            [PathSpec.from_str_path("/sums")],
            stream,
            algorithm="sha256",
            check=True,
        )
        assert await materialize(out) == b"/f: OK\n"
        assert io.exit_code == 0

    await run_with_memory(MemoryBudget(32 << 20, lambda: 0), run())
