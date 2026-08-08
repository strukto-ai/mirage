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

from mirage.commands.builtin.generic.checksum import hashsum
from mirage.types import PathSpec


class _FakeDigest:

    def __init__(self):
        self._data = b""

    def update(self, data: bytes) -> None:
        self._data += data

    def hexdigest(self) -> str:
        # Content-addressed fake: '5a' + the body's text, which the check
        # line parser accepts as hex when bodies are hex-safe.
        return "5a" + self._data.decode()


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.lstrip("/"),
                    raw_path=path)


def _fs(files: dict[str, str]):

    async def read_bytes(p: PathSpec) -> bytes:
        return files[p.virtual].encode()

    async def read_stream(p: PathSpec):
        assert isinstance(p, PathSpec)
        if p.virtual not in files:
            raise FileNotFoundError(p.virtual)
        yield files[p.virtual].encode()

    return read_bytes, read_stream


async def _run_check(files: dict[str, str],
                     cwd: str = "/",
                     **flags: bool) -> tuple[str, str, int]:
    read_bytes, read_stream = _fs(files)
    out, io = await hashsum([_spec("/sums.txt")],
                            factory=_FakeDigest,
                            algorithm="md5",
                            read_bytes=read_bytes,
                            read_stream=read_stream,
                            check=True,
                            cwd=cwd,
                            **flags)
    stdout = out.decode() if isinstance(out, bytes) else ""
    stderr = io.stderr.decode() if io.stderr else ""
    return stdout, stderr, io.exit_code


# GNU coreutils 9.7, pinned on debian:stable-slim: the per-file strerror
# lines and the WARNING block are stderr, FAILED lines are stdout, and
# --status silences everything except the strerror lines.


@pytest.mark.asyncio
async def test_missing_recorded_file_reports_both_channels():
    stdout, stderr, code = await _run_check({
        "/sums.txt": "5aabc  /ok.txt\n5aabc  /miss.txt\n",
        "/ok.txt": "abc",
    })
    assert stdout == "/ok.txt: OK\n/miss.txt: FAILED open or read\n"
    assert stderr == ("md5sum: /miss.txt: No such file or directory\n"
                      "md5sum: WARNING: 1 listed file could not be read\n")
    assert code == 1


@pytest.mark.asyncio
async def test_relative_recorded_name_resolves_against_cwd():
    # The old resolver passed relative names to the backend as bare str,
    # which died on `.virtual` before any GNU diagnostic could print.
    stdout, stderr, code = await _run_check(
        {
            "/sums.txt": "5aabc  f.txt\n",
            "/data/f.txt": "abc",
        }, cwd="/data")
    assert stdout == "f.txt: OK\n"
    assert stderr == ""
    assert code == 0


@pytest.mark.asyncio
async def test_non_fs_read_failure_propagates():

    async def read_bytes(p: PathSpec) -> bytes:
        return b"5aabc  /f.txt\n"

    async def read_stream(p: PathSpec):
        raise RuntimeError("S3 GET f failed: 403 Forbidden")
        yield b""

    with pytest.raises(RuntimeError, match="403 Forbidden"):
        await hashsum([_spec("/sums.txt")],
                      factory=_FakeDigest,
                      algorithm="md5",
                      read_bytes=read_bytes,
                      read_stream=read_stream,
                      check=True)


@pytest.mark.asyncio
async def test_mismatch_counts_into_not_match_warning():
    stdout, stderr, code = await _run_check({
        "/sums.txt": "5aface  /a.txt\n5aface  /b.txt\n",
        "/a.txt": "face",
        "/b.txt": "cafe",
    })
    assert stdout == "/a.txt: OK\n/b.txt: FAILED\n"
    assert stderr == "md5sum: WARNING: 1 computed checksum did NOT match\n"
    assert code == 1


@pytest.mark.asyncio
async def test_all_malformed_fails_alone():
    stdout, stderr, code = await _run_check({"/sums.txt": "junk\nmore junk\n"})
    assert stdout == ""
    assert stderr == ("md5sum: /sums.txt: no properly formatted checksum "
                      "lines found\n")
    assert code == 1


@pytest.mark.asyncio
async def test_ignore_missing_with_nothing_verified():
    stdout, stderr, code = await _run_check({"/sums.txt": "5aabc  /gone\n"},
                                            ignore_missing=True)
    assert stdout == ""
    assert stderr == "md5sum: /sums.txt: no file was verified\n"
    assert code == 1


@pytest.mark.asyncio
async def test_status_silences_no_file_verified_but_keeps_exit():
    stdout, stderr, code = await _run_check({"/sums.txt": "5aabc  /gone\n"},
                                            ignore_missing=True,
                                            status=True)
    assert stdout == ""
    assert stderr == ""
    assert code == 1


@pytest.mark.asyncio
async def test_status_keeps_the_no_properly_formatted_fatal():
    stdout, stderr, code = await _run_check({"/sums.txt": "junk\n"},
                                            status=True)
    assert stdout == ""
    assert stderr == ("md5sum: /sums.txt: no properly formatted checksum "
                      "lines found\n")
    assert code == 1


@pytest.mark.asyncio
async def test_malformed_plus_ignored_skip_is_no_file_verified():
    # A parsed line whose target --ignore-missing skips must not read as
    # "no properly formatted checksum lines found".
    stdout, stderr, code = await _run_check(
        {"/sums.txt": "junk\n5aabc  /gone\n"}, ignore_missing=True)
    assert stdout == ""
    assert stderr == ("md5sum: WARNING: 1 line is improperly formatted\n"
                      "md5sum: /sums.txt: no file was verified\n")
    assert code == 1


@pytest.mark.asyncio
async def test_ignore_missing_with_only_a_mismatch_reports_both():
    # GNU: zero OK lines under --ignore-missing is "no file was verified"
    # even when a mismatch was read and reported.
    stdout, stderr, code = await _run_check(
        {
            "/sums.txt": "5aface  /a.txt\n",
            "/a.txt": "cafe",
        },
        ignore_missing=True)
    assert stdout == "/a.txt: FAILED\n"
    assert stderr == ("md5sum: WARNING: 1 computed checksum did NOT match\n"
                      "md5sum: /sums.txt: no file was verified\n")
    assert code == 1


@pytest.mark.asyncio
async def test_status_keeps_strerror_lines_and_drops_summaries():
    stdout, stderr, code = await _run_check(
        {
            "/sums.txt": "5aabc  /ok.txt\n5aabc  /miss.txt\n",
            "/ok.txt": "abc",
        },
        status=True)
    assert stdout == ""
    assert stderr == "md5sum: /miss.txt: No such file or directory\n"
    assert code == 1


@pytest.mark.asyncio
async def test_warn_adds_per_line_diagnostics():
    stdout, stderr, code = await _run_check(
        {
            "/sums.txt": "bad line\n5aabc  /ok.txt\n",
            "/ok.txt": "abc",
        },
        warn=True)
    assert stdout == "/ok.txt: OK\n"
    assert stderr == ("md5sum: /sums.txt: 1: improperly formatted MD5 "
                      "checksum line\n"
                      "md5sum: WARNING: 1 line is improperly formatted\n")
    assert code == 0
