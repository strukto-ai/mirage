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

import io
import zipfile

import pytest

from mirage.commands.builtin.generic.unzip import unzip
from mirage.types import PathSpec

WORKBOOK = b"WORKBOOK-CONTENT\n"
SHEET = b"SHEET1-CONTENT\n"
APP = b"APPXML-CONTENT\n"
MEDIA = b"MEDIA-BYTES\n"


def _zip_entries(entries: tuple[tuple[str, bytes], ...]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in entries:
            zf.writestr(name, content)
    return buf.getvalue()


def _zip_bytes(names_dirs: tuple[str, ...] = ()) -> bytes:
    return _zip_entries(
        tuple((d, b"") for d in names_dirs) + (
            ("docProps/app.xml", APP),
            ("xl/sheet1.xml", SHEET),
            ("xl/media/img.bin", MEDIA),
            ("xl/workbook.xml", WORKBOOK),
        ))


class _Reader:

    def __init__(self, data: bytes) -> None:
        self.data = data

    async def __call__(self, _p: PathSpec, **_kw: object) -> bytes:
        return self.data


class _Recorder:

    def __init__(self) -> None:
        self.written: dict[str, bytes] = {}

    async def __call__(self, p: PathSpec, content: bytes) -> None:
        self.written[p.virtual] = content


async def _no_write(_p: PathSpec, _content: bytes) -> None:
    raise AssertionError("write_bytes must not be called")


async def _no_mkdir(_p: PathSpec, parents: bool = False) -> None:
    raise AssertionError("mkdir_fn must not be called")


async def _mkdir_ok(_p: PathSpec, parents: bool = False) -> None:
    return None


def _archive() -> list[PathSpec]:
    return [PathSpec.from_str_path("/a.zip")]


async def _run(members: tuple[str, ...], data: bytes | None = None, **kw):
    recorder = _Recorder()
    out, res = await unzip(
        _archive(),
        read_bytes=_Reader(_zip_bytes() if data is None else data),
        write_bytes=recorder,
        mkdir_fn=_mkdir_ok,
        members=members,
        **kw,
    )
    return out, res, recorder.written


def _stderr_text(res) -> str:
    return (res.stderr or b"").decode() if res.stderr is not None else ""


@pytest.mark.asyncio
async def test_p_single_member_outputs_only_that_member():
    out, res, _ = await _run(("xl/workbook.xml", ), p=True)
    assert out == WORKBOOK
    assert res.exit_code == 0
    assert res.stderr is None


@pytest.mark.asyncio
async def test_p_missing_member_exit_11_caution_on_stderr():
    out, res, _ = await _run(("NOSUCHFILE.xml", ), p=True)
    assert out in (None, b"")
    assert res.exit_code == 11
    assert _stderr_text(res) == (
        "caution: filename not matched:  NOSUCHFILE.xml\n")


@pytest.mark.asyncio
async def test_p_hit_and_miss_prints_hit_and_exits_11():
    out, res, _ = await _run(("xl/workbook.xml", "NOSUCHFILE.xml"), p=True)
    assert out == WORKBOOK
    assert res.exit_code == 11
    assert _stderr_text(res) == (
        "caution: filename not matched:  NOSUCHFILE.xml\n")


@pytest.mark.asyncio
async def test_p_output_follows_archive_order_not_arg_order():
    out, res, _ = await _run(("xl/workbook.xml", "docProps/app.xml"), p=True)
    assert out == APP + WORKBOOK
    assert res.exit_code == 0


@pytest.mark.asyncio
async def test_p_wildcard_star_crosses_slash():
    out, res, _ = await _run(("doc*", ), p=True)
    assert out == APP
    assert res.exit_code == 0


@pytest.mark.asyncio
async def test_p_wildcard_subtree():
    out, res, _ = await _run(("xl/*", ), p=True)
    assert out == SHEET + MEDIA + WORKBOOK
    assert res.exit_code == 0


@pytest.mark.asyncio
async def test_p_first_match_wins_attribution():
    out, res, _ = await _run(("*.xml", "xl/workbook.xml"), p=True)
    assert out == APP + SHEET + WORKBOOK
    assert res.exit_code == 11
    assert _stderr_text(res) == (
        "caution: filename not matched:  xl/workbook.xml\n")


@pytest.mark.asyncio
async def test_p_duplicate_spec_cautions_second():
    out, res, _ = await _run(("xl/workbook.xml", "xl/workbook.xml"), p=True)
    assert out == WORKBOOK
    assert res.exit_code == 11
    assert _stderr_text(res) == (
        "caution: filename not matched:  xl/workbook.xml\n")


@pytest.mark.asyncio
async def test_p_dir_entry_spec_matches_with_no_output():
    out, res = await unzip(
        _archive(),
        read_bytes=_Reader(_zip_bytes(names_dirs=("xl/", ))),
        write_bytes=_no_write,
        mkdir_fn=_no_mkdir,
        members=("xl/", ),
        p=True,
    )
    assert out in (None, b"")
    assert res.exit_code == 0


@pytest.mark.asyncio
@pytest.mark.filterwarnings("ignore:Duplicate name:UserWarning")
async def test_p_duplicate_names_serve_each_entrys_own_data():
    data = _zip_entries((("dup.txt", b"FIRST\n"), ("dup.txt", b"SECOND\n")))
    out, res, _ = await _run(("dup.txt", ), data=data, p=True)
    assert out == b"FIRST\nSECOND\n"
    assert res.exit_code == 0


@pytest.mark.asyncio
async def test_p_question_mark_matches_one_byte_not_one_code_point():
    data = _zip_entries((("é.txt", b"ACCENT\n"), ("ab.txt", b"AB\n")))
    out, res, _ = await _run(("?.txt", ), data=data, p=True)
    assert out in (None, b"")
    assert res.exit_code == 11
    assert _stderr_text(res) == "caution: filename not matched:  ?.txt\n"
    out, res, _ = await _run(("??.txt", ), data=data, p=True)
    assert out == b"ACCENT\nAB\n"
    assert res.exit_code == 0


@pytest.mark.asyncio
async def test_p_no_members_concats_whole_archive():
    out, res, _ = await _run((), p=True)
    assert out == APP + SHEET + MEDIA + WORKBOOK
    assert res.exit_code == 0


@pytest.mark.asyncio
async def test_l_filters_rows_to_members():
    out, res, _ = await _run(("xl/workbook.xml", ), args_l=True)
    text = out.decode()
    assert "xl/workbook.xml" in text
    assert "docProps/app.xml" not in text
    assert res.exit_code == 0


@pytest.mark.asyncio
async def test_l_all_miss_exits_11_without_stderr():
    out, res, _ = await _run(("NOSUCHFILE.xml", ), args_l=True)
    text = out.decode()
    assert "NOSUCHFILE" not in text
    assert res.exit_code == 11
    assert res.stderr is None


@pytest.mark.asyncio
async def test_l_partial_match_exits_0():
    out, res, _ = await _run(("xl/workbook.xml", "NOSUCHFILE.xml"),
                             args_l=True)
    assert "xl/workbook.xml" in out.decode()
    assert res.exit_code == 0
    assert res.stderr is None


@pytest.mark.asyncio
async def test_t_member_ok():
    out, res, _ = await _run(("xl/workbook.xml", ), t=True)
    assert b"No errors detected" in out
    assert res.exit_code == 0


@pytest.mark.asyncio
async def test_t_missing_member_caution_on_stdout_exit_11():
    out, res, _ = await _run(("xl/workbook.xml", "NOSUCHFILE.xml"), t=True)
    text = out.decode()
    assert "caution: filename not matched:  NOSUCHFILE.xml" in text
    assert "At least one error was detected" in text
    assert res.exit_code == 11
    assert res.stderr is None


@pytest.mark.asyncio
async def test_extract_writes_only_selected_members():
    out, res, written = await _run(("xl/workbook.xml", ))
    assert set(written) == {"/xl/workbook.xml"}
    assert written["/xl/workbook.xml"] == WORKBOOK
    assert "inflating: /xl/workbook.xml" in out.decode()
    assert "app.xml" not in out.decode()
    assert res.exit_code == 0


@pytest.mark.asyncio
async def test_extract_missing_member_caution_stderr_exit_11():
    out, res, written = await _run(("docProps/app.xml", "NOSUCHFILE.xml"))
    assert set(written) == {"/docProps/app.xml"}
    assert res.exit_code == 11
    assert _stderr_text(res) == (
        "caution: filename not matched:  NOSUCHFILE.xml\n")


@pytest.mark.asyncio
async def test_extract_wildcard_selects_subtree():
    out, res, written = await _run(("xl/*", ))
    assert set(written) == {
        "/xl/sheet1.xml", "/xl/media/img.bin", "/xl/workbook.xml"
    }
    assert res.exit_code == 0
