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

from mirage.commands.errors import UsageError
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

from mirage.commands.builtin.generic.unzip import (  # isort: skip
    CORRUPT_CDIR, EXTRA_BYTES, MISSING_BYTES, NO_EOCD, UNZIP_NO_DIRECTORY,
    ZERO_TESTED, ZIPINFO_NO_DIRECTORY, unzip)

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

    async def __call__(self, p: PathSpec, data: bytes) -> None:
        self.written[p.virtual] = data


async def _no_write(_p: PathSpec, data: bytes) -> None:
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


PLAIN = b"plain text"
STAMP = (2026, 9, 20, 7, 33, 0)


def _stored(entries: tuple[tuple[str, bytes], ...]) -> bytes:
    """An archive with fixed stamps and modes, so every row is pinned."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in entries:
            info = zipfile.ZipInfo(name, date_time=STAMP)
            info.create_system = 3
            info.external_attr = ((0o40775 << 16) | 0x10
                                  if name.endswith("/") else 0o600 << 16)
            zf.writestr(info, content)
    return buf.getvalue()


MULTI = (("dir/", b""), ("dir/a.txt", b"a" * 200), ("b.txt", b"b"))


@pytest.mark.asyncio
async def test_plain_text_is_refused_as_no_archive():
    out, res, written = await _run((), data=PLAIN, args_l=True)
    assert out is None
    assert res.exit_code == 9
    assert _stderr_text(res) == NO_EOCD + UNZIP_NO_DIRECTORY.format("/a.zip")
    assert written == {}


@pytest.mark.asyncio
async def test_empty_file_is_refused_as_no_archive():
    out, res, _ = await _run((), data=b"")
    assert out is None
    assert res.exit_code == 9
    assert _stderr_text(res) == NO_EOCD + UNZIP_NO_DIRECTORY.format("/a.zip")


@pytest.mark.asyncio
async def test_pipe_refusal_names_the_archive_and_does_not_sign():
    out, res, _ = await _run((), data=PLAIN, p=True)
    assert out is None
    assert res.exit_code == 9
    assert _stderr_text(res) == "[/a.zip]\n" + NO_EOCD


@pytest.mark.asyncio
async def test_zipinfo_refusal_signs_as_zipinfo():
    out, res, _ = await _run((), data=PLAIN, Z=True, args_1=True)
    assert out is None
    assert res.exit_code == 9
    assert _stderr_text(res) == ("[/a.zip]\n" + NO_EOCD +
                                 ZIPINFO_NO_DIRECTORY.format("/a.zip"))


@pytest.mark.asyncio
async def test_corrupt_central_directory_exits_3():
    data = bytearray(_stored(MULTI))
    at = data.find(b"PK\x01\x02")
    data[at:at + 4] = b"XXXX"
    out, res, _ = await _run((), data=bytes(data), args_l=True)
    assert out is None
    assert res.exit_code == 3
    assert _stderr_text(res) == CORRUPT_CDIR.format("/a.zip")


@pytest.mark.asyncio
async def test_entry_reaching_past_the_directory_exits_3():
    data = bytearray(_stored(MULTI))
    at = data.find(b"PK\x01\x02")
    data[at + 28:at + 30] = (0xFFFF).to_bytes(2, "little")
    out, res, _ = await _run((), data=bytes(data), args_l=True)
    assert out is None
    assert res.exit_code == 3
    assert _stderr_text(res) == CORRUPT_CDIR.format("/a.zip")


@pytest.mark.asyncio
async def test_entry_count_short_of_the_directory_exits_3():
    data = bytearray(_stored(MULTI))
    at = data.rfind(b"PK\x05\x06")
    data[at + 10:at + 12] = (2).to_bytes(2, "little")
    out, res, _ = await _run((), data=bytes(data), Z=True)
    assert out is None
    assert res.exit_code == 3
    assert _stderr_text(res) == CORRUPT_CDIR.format("/a.zip")


@pytest.mark.asyncio
async def test_prefixed_archive_lists_with_the_extra_bytes_warning():
    out, res, _ = await _run((),
                             data=b"#!/bin/sh\n" + _stored(MULTI),
                             Z=True,
                             args_1=True)
    assert out == b"dir/\ndir/a.txt\nb.txt\n"
    assert res.exit_code == 1
    assert _stderr_text(res) == EXTRA_BYTES.format("/a.zip", 10, "s")


@pytest.mark.asyncio
async def test_extra_bytes_warning_precedes_cautions_and_yields_to_11():
    out, res, _ = await _run(("nomatch", ), data=b"X" + _stored(MULTI), p=True)
    assert out in (None, b"")
    assert res.exit_code == 11
    assert _stderr_text(res) == (EXTRA_BYTES.format("/a.zip", 1, "") +
                                 "caution: filename not matched:  nomatch\n")


@pytest.mark.asyncio
async def test_missing_bytes_is_an_error_that_still_lists():
    data = _stored(MULTI)
    # Point the end record 3 bytes past where the directory really is.
    at = data.rfind(b"PK\x05\x06")
    offset = int.from_bytes(data[at + 16:at + 20], "little") + 3
    patched = data[:at + 16] + offset.to_bytes(4, "little") + data[at + 20:]
    out, res, _ = await _run((), data=patched, Z=True, args_1=True)
    assert out == b"dir/\ndir/a.txt\nb.txt\n"
    assert res.exit_code == 2
    assert _stderr_text(res) == MISSING_BYTES.format("/a.zip", 3)


@pytest.mark.asyncio
async def test_z1_lists_names_only():
    out, res, _ = await _run((),
                             data=_stored(MULTI),
                             Z=True,
                             args_1=True,
                             h=True,
                             t=True)
    assert out == b"dir/\ndir/a.txt\nb.txt\n"
    assert res.exit_code == 0
    assert res.stderr is None


@pytest.mark.asyncio
async def test_z_default_prints_header_rows_and_totals():
    data = _stored(MULTI)
    out, res, _ = await _run((), data=data, Z=True)
    assert out == (
        "Archive:  /a.zip\n"
        f"Zip file size: {len(data)} bytes, number of entries: 3\n"
        "drwxrwxr-x  2.0 unx        0 b- stor 26-Sep-20 07:33 dir/\n"
        "?rw-------  2.0 unx      200 b- stor 26-Sep-20 07:33 dir/a.txt\n"
        "?rw-------  2.0 unx        1 b- stor 26-Sep-20 07:33 b.txt\n"
        "3 files, 201 bytes uncompressed, 201 bytes compressed:  0.0%\n"
    ).encode()
    assert res.exit_code == 0


@pytest.mark.asyncio
async def test_zl_adds_the_compressed_size_column():
    out, res, _ = await _run(("b.txt", ),
                             data=_stored(MULTI),
                             Z=True,
                             args_l=True)
    assert out == (b"?rw-------  2.0 unx        1 b-        1 stor "
                   b"26-Sep-20 07:33 b.txt\n")
    assert res.exit_code == 0


@pytest.mark.asyncio
async def test_zh_and_zt_alone_print_only_that_line():
    data = _stored(MULTI)
    out, _, _ = await _run((), data=data, Z=True, h=True)
    assert out == (
        "Archive:  /a.zip\n"
        f"Zip file size: {len(data)} bytes, number of entries: 3\n").encode()
    out, _, _ = await _run((), data=data, Z=True, t=True)
    assert out == (b"3 files, 201 bytes uncompressed, 201 bytes compressed:"
                   b"  0.0%\n")


@pytest.mark.asyncio
async def test_z2_keeps_the_header_that_was_asked_for():
    data = _stored(MULTI)
    out, _, _ = await _run((), data=data, Z=True, args_2=True, h=True)
    assert out == ("Archive:  /a.zip\n"
                   f"Zip file size: {len(data)} bytes, number of entries: 3\n"
                   "dir/\ndir/a.txt\nb.txt\n").encode()


@pytest.mark.asyncio
async def test_z_member_miss_exits_11_with_caution():
    out, res, _ = await _run(("nomatch", ),
                             data=_stored(MULTI),
                             Z=True,
                             args_1=True)
    assert out is None
    assert res.exit_code == 11
    assert _stderr_text(res) == "caution: filename not matched:  nomatch\n"


@pytest.mark.asyncio
async def test_z_member_hit_and_miss_exits_0_with_caution():
    out, res, _ = await _run(("dir/*", "nomatch"),
                             data=_stored(MULTI),
                             Z=True,
                             args_1=True)
    assert out == b"dir/\ndir/a.txt\n"
    assert res.exit_code == 0
    assert _stderr_text(res) == "caution: filename not matched:  nomatch\n"


@pytest.mark.asyncio
async def test_zipinfo_letters_need_z():
    with pytest.raises(UsageError) as caught:
        await _run((), data=_stored(MULTI), args_1=True)
    assert caught.value.exit_code == 10
    assert str(caught.value) == "unzip: -1 is a ZipInfo option and needs -Z"
    with pytest.raises(UsageError):
        await _run((), data=_stored(MULTI), h=True)


@pytest.mark.asyncio
async def test_zm_and_zs_pick_the_row_format():
    out, _, _ = await _run(("b.txt", ), data=_stored(MULTI), Z=True, m=True)
    assert out == (b"?rw-------  2.0 unx        1 b-  0% stor "
                   b"26-Sep-20 07:33 b.txt\n")
    out, _, _ = await _run(("b.txt", ), data=_stored(MULTI), Z=True, s=True)
    assert out == (b"?rw-------  2.0 unx        1 b- stor "
                   b"26-Sep-20 07:33 b.txt\n")
    with pytest.raises(UsageError) as caught:
        await _run((), data=_stored(MULTI), m=True)
    assert str(caught.value) == "unzip: -m is a ZipInfo option and needs -Z"


@pytest.mark.asyncio
async def test_x_excludes_and_counts_as_a_filter_for_the_layout():
    out, res, _ = await _run((), data=_stored(MULTI), Z=True, x=("b.txt", ))
    assert out == (
        b"drwxrwxr-x  2.0 unx        0 b- stor 26-Sep-20 07:33 dir/\n"
        b"?rw-------  2.0 unx      200 b- stor 26-Sep-20 07:33 dir/a.txt\n")
    assert res.exit_code == 0
    assert res.stderr is None


@pytest.mark.asyncio
async def test_x_unmatched_is_a_caution_not_an_error():
    out, res, _ = await _run(("dir/*", ),
                             data=_stored(MULTI),
                             Z=True,
                             args_1=True,
                             x=("nomatch", ))
    assert out == b"dir/\ndir/a.txt\n"
    assert res.exit_code == 0
    assert _stderr_text(res) == (
        "caution: excluded filename not matched:  nomatch\n")


@pytest.mark.asyncio
async def test_x_that_leaves_nothing_exits_11_in_every_mode():
    data = _stored(MULTI)
    out, res, _ = await _run((), data=data, Z=True, args_1=True, x=("*", ))
    assert out is None and res.exit_code == 11 and res.stderr is None
    out, res, _ = await _run((), data=data, args_l=True, x=("*", ))
    assert out == b"  Length      Name\n---------  ----\n"
    assert res.exit_code == 11
    out, res, _ = await _run((), data=data, p=True, x=("*", ))
    assert out == b"" and res.exit_code == 11
    out, res, _ = await _run((), data=data, t=True, x=("*", ))
    assert out == ZERO_TESTED.format("/a.zip").encode()
    assert res.exit_code == 11
    out, res, written = await _run((), data=data, x=("*", ))
    assert out is None and res.exit_code == 11 and written == {}


@pytest.mark.asyncio
async def test_x_excluded_member_still_counts_for_its_include():
    out, res, _ = await _run(("dir/*", ),
                             data=_stored(MULTI),
                             Z=True,
                             args_1=True,
                             x=("dir/a.txt", ))
    assert out == b"dir/\n"
    assert res.exit_code == 0
    assert res.stderr is None


@pytest.mark.asyncio
async def test_t_reports_both_caution_kinds_on_stdout():
    out, res, _ = await _run(("nomatch", ),
                             data=_stored(MULTI),
                             t=True,
                             x=("b.txt", ))
    assert out == (b"caution: filename not matched:  nomatch\n"
                   b"caution: excluded filename not matched:  b.txt\n"
                   b"At least one error was detected in /a.zip.\n")
    assert res.exit_code == 11
    out, res, _ = await _run((), data=_stored(MULTI), t=True, x=("nomatch", ))
    assert out == (b"caution: excluded filename not matched:  nomatch\n"
                   b"No errors detected in /a.zip\n")
    assert res.exit_code == 0


@pytest.mark.asyncio
async def test_p_excludes_and_cautions_on_stderr():
    out, res, _ = await _run((),
                             data=_stored(MULTI),
                             p=True,
                             x=("dir/*", "nomatch"))
    assert out == b"b"
    assert res.exit_code == 0
    assert _stderr_text(res) == (
        "caution: excluded filename not matched:  nomatch\n")


def _read_only_unzip_mount() -> tuple[Workspace, RAMVFS]:
    vfs = RAMVFS()
    vfs._store.files["/a.zip"] = _zip_entries((("f.txt", b"hello\n"), ))
    return Workspace({"/ro/": (vfs, MountMode.READ)}), vfs


@pytest.mark.asyncio
@pytest.mark.parametrize("line", [
    "unzip -l /ro/a.zip",
    "unzip -t /ro/a.zip",
    "unzip -p /ro/a.zip f.txt",
    "unzip -Z /ro/a.zip",
    "unzip -Z -1 /ro/a.zip",
])
async def test_a_read_only_mount_runs_unzip_where_it_writes_nothing(line: str):
    ws, vfs = _read_only_unzip_mount()
    before = dict(vfs._store.files)
    result = await ws.shell(line)
    await result.materialize_stdout()
    assert result.exit_code == 0
    assert vfs._store.files == before


@pytest.mark.asyncio
@pytest.mark.parametrize("line", [
    "cd /ro && unzip a.zip",
    "cd /ro && unzip -o a.zip",
    "unzip -d /ro/out /ro/a.zip",
])
async def test_a_read_only_mount_refuses_unzip_at_the_write(line: str):
    ws, vfs = _read_only_unzip_mount()
    before = dict(vfs._store.files)
    result = await ws.shell(line)
    assert result.exit_code != 0
    assert b"Read-only file system" in (result.stderr or b"")
    assert vfs._store.files == before
