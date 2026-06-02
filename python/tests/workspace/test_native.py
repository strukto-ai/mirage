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

import tempfile

import pytest

from mirage.workspace.native import native_exec, native_exec_stream


@pytest.mark.asyncio
async def test_native_exec_echo():
    with tempfile.TemporaryDirectory() as tmpdir:
        stdout, stderr, code = await native_exec("echo hello", cwd=tmpdir)
        assert stdout == b"hello\n"
        assert code == 0


@pytest.mark.asyncio
async def test_native_exec_pipe():
    with tempfile.TemporaryDirectory() as tmpdir:
        stdout, stderr, code = await native_exec(
            "echo hello world | tr ' ' '\\n' | sort",
            cwd=tmpdir,
        )
        assert b"hello" in stdout
        assert b"world" in stdout
        assert code == 0


@pytest.mark.asyncio
async def test_native_exec_file_ops():
    with tempfile.TemporaryDirectory() as tmpdir:
        stdout, stderr, code = await native_exec(
            "echo 'test content' > file.txt && cat file.txt",
            cwd=tmpdir,
        )
        assert stdout == b"test content\n"
        assert code == 0


@pytest.mark.asyncio
async def test_native_exec_nonzero_exit():
    with tempfile.TemporaryDirectory() as tmpdir:
        stdout, stderr, code = await native_exec("false", cwd=tmpdir)
        assert code != 0


@pytest.mark.asyncio
async def test_native_exec_stderr():
    with tempfile.TemporaryDirectory() as tmpdir:
        stdout, stderr, code = await native_exec(
            "echo error >&2",
            cwd=tmpdir,
        )
        assert b"error" in stderr
        assert code == 0


@pytest.mark.asyncio
async def test_native_exec_stream():
    with tempfile.TemporaryDirectory() as tmpdir:
        proc = await native_exec_stream("seq 1 5", cwd=tmpdir)
        chunks = []
        async for chunk in proc.stdout_stream():
            chunks.append(chunk)
        assert b"".join(chunks) == b"1\n2\n3\n4\n5\n"
        exit_code = await proc.wait()
        assert exit_code == 0


@pytest.mark.asyncio
async def test_native_exec_times_out_with_attributed_stderr():
    with tempfile.TemporaryDirectory() as tmpdir:
        stdout, stderr, code = await native_exec("sleep 5",
                                                 cwd=tmpdir,
                                                 timeout=0.1,
                                                 name="sleep")
        assert code == 124
        assert b"sleep: timed out after 0.1s" in stderr
