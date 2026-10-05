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

import pytest

from mirage.commands.builtin.generic.checksum import checksum
from mirage.types import PathSpec


class _FakeDigest:
    def __init__(self):
        self._data = b""

    def update(self, data: bytes) -> None:
        self._data += data

    def hexdigest(self) -> str:
        # Content-addressed fake: '5a' + the body's text, zero-padded to an
        # md5's 32 digits, which the check line parser accepts as hex when
        # bodies are hex-safe.
        return ("5a" + self._data.decode()).ljust(32, "0")


_DIGEST = "5aabc".ljust(32, "0")


def _spec(path: str) -> PathSpec:
    return PathSpec(
        virtual=path, directory=path, vfs_path=path.lstrip("/"), raw_path=path
    )


def _fs(files: dict[str, str]):
    async def read_bytes(p: PathSpec) -> bytes:
        if p.virtual not in files:
            raise FileNotFoundError(p.virtual)
        return files[p.virtual].encode()

    async def read_stream(p: PathSpec):
        assert isinstance(p, PathSpec)
        if p.virtual not in files:
            raise FileNotFoundError(p.virtual)
        yield files[p.virtual].encode()

    return read_bytes, read_stream


async def _run_check(
    files: dict[str, str],
    cwd: str = "/",
    paths: list[str] | None = None,
    **flags: bool,
) -> tuple[str, str, int]:
    read_bytes, read_stream = _fs(files)
    out, io = await checksum(
        [_spec(p) for p in (paths or ["/sums.txt"])],
        factory=_FakeDigest,
        algorithm="md5",
        read_bytes=read_bytes,
        read_stream=read_stream,
        check=True,
        cwd=cwd,
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
async def test_non_fs_read_failure_propagates():
    async def read_bytes(p: PathSpec) -> bytes:
        return b"5aabc000000000000000000000000000  /f.txt\n"

    async def read_stream(p: PathSpec):
        raise RuntimeError("S3 GET f failed: 403 Forbidden")
        yield b""

    with pytest.raises(RuntimeError, match="403 Forbidden"):
        await checksum(
            [_spec("/sums.txt")],
            factory=_FakeDigest,
            algorithm="md5",
            read_bytes=read_bytes,
            read_stream=read_stream,
            check=True,
        )
