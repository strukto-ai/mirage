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

import base64

import pytest

from mirage import MountMode, RAMResource, Workspace
from mirage.agents.langchain.backend import LangchainWorkspace


@pytest.fixture
def workspace():
    return Workspace({"/": RAMResource()}, mode=MountMode.WRITE)


@pytest.fixture
def backend(workspace):
    return LangchainWorkspace(workspace)


def test_id(backend):
    assert backend.id == "mirage"


def test_custom_id(workspace):
    b = LangchainWorkspace(workspace, sandbox_id="custom")
    assert b.id == "custom"


@pytest.mark.asyncio
async def test_aexecute_echo(backend):
    resp = await backend.aexecute("echo hello")
    assert resp.exit_code == 0
    assert "hello" in resp.output


@pytest.mark.asyncio
async def test_aexecute_failing_command(backend):
    resp = await backend.aexecute("cat /nonexistent")
    assert resp.exit_code != 0


@pytest.mark.asyncio
async def test_sync_execute_is_safe_inside_running_event_loop(backend):
    resp = backend.execute("echo nested")
    assert resp.exit_code == 0
    assert "nested" in resp.output


@pytest.mark.asyncio
async def test_awrite_and_aread(backend):
    result = await backend.awrite("/test.txt", "hello world")
    assert result.error is None

    read_result = await backend.aread("/test.txt")
    assert read_result.error is None
    assert read_result.file_data == {
        "content": "hello world",
        "encoding": "utf-8",
    }


@pytest.mark.asyncio
async def test_aread_paginates_text_without_line_numbers(backend):
    await backend.awrite("/lines.txt", "zero\none\ntwo\nthree\n")

    result = await backend.aread("/lines.txt", offset=1, limit=2)

    assert result.error is None
    assert result.file_data == {
        "content": "one\ntwo\n",
        "encoding": "utf-8",
    }


@pytest.mark.asyncio
async def test_aread_reports_out_of_range_offset(backend):
    await backend.awrite("/lines.txt", "zero\none\n")

    result = await backend.aread("/lines.txt", offset=2)

    assert result.file_data is None
    assert result.error == "Line offset 2 exceeds file length (2 lines)"


@pytest.mark.asyncio
async def test_aread_encodes_pdf_as_base64(backend):
    content = b"%PDF-1.7\n\x00binary"
    await backend.aupload_files([("/document.pdf", content)])

    result = await backend.aread("/document.pdf")

    assert result.error is None
    assert result.file_data == {
        "content": base64.standard_b64encode(content).decode("ascii"),
        "encoding": "base64",
    }


@pytest.mark.asyncio
async def test_awrite_existing_file_errors(backend):
    await backend.awrite("/exists.txt", "first")
    result = await backend.awrite("/exists.txt", "second")
    assert result.error is not None


@pytest.mark.asyncio
async def test_aedit(backend):
    await backend.awrite("/edit.txt", "foo bar baz")
    result = await backend.aedit("/edit.txt", "bar", "qux")
    assert result.error is None
    read_result = await backend.aread("/edit.txt")
    assert read_result.file_data is not None
    assert "qux" in read_result.file_data["content"]
    assert "bar" not in read_result.file_data["content"]


@pytest.mark.asyncio
async def test_als(backend):
    await backend.awrite("/dir/a.txt", "a")
    await backend.awrite("/dir/b.txt", "b")
    result = await backend.als("/dir")
    assert result.entries is not None
    entries = result.entries
    paths = [e["path"] for e in entries]
    assert len(paths) == 2


@pytest.mark.asyncio
async def test_als_reports_command_errors(backend):
    result = await backend.als("/missing")

    assert result.entries is None
    assert result.error is not None


@pytest.mark.asyncio
async def test_agrep(backend):
    await backend.awrite("/search.txt",
                         "hello world\ngoodbye world\nhello again")
    result = await backend.agrep("hello", path="/")
    assert result.matches is not None
    assert len(result.matches) >= 2


@pytest.mark.asyncio
async def test_aglob(backend):
    await backend.awrite("/data/a.txt", "a")
    await backend.awrite("/data/b.py", "b")
    result = await backend.aglob("*.txt", path="/data")
    assert result.matches is not None
    entries = result.matches
    paths = [e["path"] for e in entries]
    assert any("a.txt" in p for p in paths)
    assert not any("b.py" in p for p in paths)


@pytest.mark.asyncio
async def test_aglob_reports_command_errors(backend):
    result = await backend.aglob("*.txt", path="/missing")

    assert result.matches is None
    assert result.error is not None


@pytest.mark.asyncio
async def test_execute_pipe(backend):
    await backend.awrite("/pipe.txt", "aaa\nbbb\nccc\naaa\n")
    resp = await backend.aexecute("cat /pipe.txt | sort | uniq | wc -l")
    assert resp.exit_code == 0
    assert "3" in resp.output


@pytest.mark.asyncio
async def test_upload_and_download(backend):
    files = [("/up1.txt", b"content1"), ("/up2.txt", b"content2")]
    up_results = await backend.aupload_files(files)
    assert all(r.error is None for r in up_results)

    down_results = await backend.adownload_files(["/up1.txt", "/up2.txt"])
    assert down_results[0].content == b"content1"
    assert down_results[1].content == b"content2"
