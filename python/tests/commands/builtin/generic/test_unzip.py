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

import errno
import io
import zipfile

import pytest

from mirage.commands.builtin.generic.unzip import (
    CORRUPT_CDIR,
    EXTRA_BYTES,
    MISSING_BYTES,
    ZERO_TESTED,
    unzip,
)
from mirage.commands.errors import UsageError
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

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


def _zip_bytes() -> bytes:
    return _zip_entries(
        (
            ("docProps/app.xml", APP),
            ("xl/sheet1.xml", SHEET),
            ("xl/media/img.bin", MEDIA),
            ("xl/workbook.xml", WORKBOOK),
        )
    )


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
@pytest.mark.parametrize(
    "members,out,code,stderr",
    [
        (("xl/workbook.xml", "docProps/app.xml"), APP + WORKBOOK, 0, ""),
        (
            ("*.xml", "xl/workbook.xml"),
            APP + SHEET + WORKBOOK,
            11,
            "caution: filename not matched:  xl/workbook.xml\n",
        ),
        (("xl/*",), SHEET + MEDIA + WORKBOOK, 0, ""),
    ],
)
async def test_p_selects_in_archive_order_charging_the_first_match(
    members, out, code, stderr
):
    got, res, _ = await _run(members, p=True)
    assert (got, res.exit_code, _stderr_text(res)) == (out, code, stderr)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "members,listed,code",
    [
        (("NOSUCHFILE.xml",), False, 11),
        (("xl/workbook.xml", "NOSUCHFILE.xml"), True, 0),
    ],
)
async def test_l_filters_rows_and_exits_11_only_when_nothing_matched(
    members, listed, code
):
    out, res, _ = await _run(members, args_l=True)
    text = out.decode()
    assert ("xl/workbook.xml" in text) is listed
    assert "docProps/app.xml" not in text
    assert (res.exit_code, res.stderr) == (code, None)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "members,said,code",
    [
        (("xl/workbook.xml",), "No errors detected", 0),
        (
            ("xl/workbook.xml", "NOSUCHFILE.xml"),
            "caution: filename not matched:  NOSUCHFILE.xml",
            11,
        ),
    ],
)
async def test_t_reports_on_stdout(members, said, code):
    out, res, _ = await _run(members, t=True)
    assert said in out.decode()
    assert (res.exit_code, res.stderr) == (code, None)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "members,written,code,stderr",
    [
        (
            ("xl/workbook.xml", "NOSUCHFILE.xml"),
            {"/xl/workbook.xml": WORKBOOK},
            11,
            "caution: filename not matched:  NOSUCHFILE.xml\n",
        ),
        (
            ("xl/*",),
            {
                "/xl/sheet1.xml": SHEET,
                "/xl/media/img.bin": MEDIA,
                "/xl/workbook.xml": WORKBOOK,
            },
            0,
            "",
        ),
    ],
)
async def test_extract_writes_only_the_selected_members(
    members, written, code, stderr
):
    out, res, got = await _run(members)
    assert got == written
    assert out.decode() == "Archive:  /a.zip\n" + "".join(
        f"  inflating: {path[1:]:<22}  \n" for path in written
    )
    assert (res.exit_code, _stderr_text(res)) == (code, stderr)


STAMP = (2026, 9, 20, 7, 33, 0)


def _stored(entries: tuple[tuple[str, bytes], ...]) -> bytes:
    """An archive with fixed stamps and modes, so every row is pinned."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in entries:
            info = zipfile.ZipInfo(name, date_time=STAMP)
            info.create_system = 3
            info.external_attr = (
                (0o40775 << 16) | 0x10 if name.endswith("/") else 0o600 << 16
            )
            zf.writestr(info, content)
    return buf.getvalue()


MULTI = (("dir/", b""), ("dir/a.txt", b"a" * 200), ("b.txt", b"b"))
# What -t prints for each of MULTI's members (UnZip 6.00).
MULTI_TESTED = (
    b"    testing: dir/                     OK\n"
    b"    testing: dir/a.txt                OK\n"
    b"    testing: b.txt                    OK\n"
)


def _patch(data: bytes, sig: bytes, at: int, value: int, width: int) -> bytes:
    pos = data.find(sig) + at
    return data[:pos] + value.to_bytes(width, "little") + data[pos + width :]


_MULTI_ZIP = _stored(MULTI)
_END = _MULTI_ZIP.find(b"PK\x05\x06")
_CDIR_AT = int.from_bytes(_MULTI_ZIP[_END + 16 : _END + 20], "little")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data,members,flags,out,code,stderr",
    [
        (
            _patch(_MULTI_ZIP, b"PK\x01\x02", 28, 0xFFFF, 2),
            (),
            {"args_l": True},
            None,
            3,
            CORRUPT_CDIR.format("/a.zip"),
        ),
        (
            _patch(_MULTI_ZIP, b"PK\x05\x06", 10, 2, 2),
            (),
            {"Z": True},
            None,
            3,
            CORRUPT_CDIR.format("/a.zip"),
        ),
        (
            b"X" + _MULTI_ZIP,
            ("nomatch",),
            {"p": True},
            b"",
            11,
            EXTRA_BYTES.format("/a.zip", 1, "")
            + "caution: filename not matched:  nomatch\n",
        ),
        (
            _patch(_MULTI_ZIP, b"PK\x05\x06", 16, _CDIR_AT + 3, 4),
            (),
            {"Z": True, "args_1": True},
            b"dir/\ndir/a.txt\nb.txt\n",
            2,
            MISSING_BYTES.format("/a.zip", 3),
        ),
    ],
)
async def test_a_damaged_archive_is_reported_and_served_where_it_can_be(
    data, members, flags, out, code, stderr
):
    # An entry reaching past the directory and an entry count short of
    # it are fatal; bytes before the archive and bytes missing from it
    # are named and the archive is still read.
    got, res, _ = await _run(members, data=data, **flags)
    assert (got or None, res.exit_code, _stderr_text(res)) == (
        out or None,
        code,
        stderr,
    )


@pytest.mark.asyncio
async def test_z1_lists_names_only():
    out, res, _ = await _run(
        (), data=_stored(MULTI), Z=True, args_1=True, h=True, t=True
    )
    assert out == b"dir/\ndir/a.txt\nb.txt\n"
    assert res.exit_code == 0
    assert res.stderr is None


@pytest.mark.asyncio
@pytest.mark.parametrize("listing", [{"args_l": True}, {"v": True}])
async def test_t_and_p_outrank_the_listing_letters(listing):
    # Info-ZIP lists only when neither -t nor -p picks another mode.
    out, _, _ = await _run(("b.txt",), data=_stored(MULTI), p=True, **listing)
    assert out == b"b"
    out, _, _ = await _run((), data=_stored(MULTI), t=True, **listing)
    assert out == (
        b"Archive:  /a.zip\n"
        + MULTI_TESTED
        + b"No errors detected in compressed data of /a.zip.\n"
    )


@pytest.mark.asyncio
async def test_zipinfo_letters_need_z():
    with pytest.raises(UsageError) as caught:
        await _run((), data=_stored(MULTI), args_1=True)
    assert caught.value.exit_code == 10
    assert str(caught.value) == "unzip: -1 is a ZipInfo option and needs -Z"
    with pytest.raises(UsageError):
        await _run((), data=_stored(MULTI), h=True)


@pytest.mark.asyncio
async def test_x_that_leaves_nothing_exits_11_in_every_mode():
    data = _stored(MULTI)
    out, res, _ = await _run((), data=data, Z=True, args_1=True, x=("*",))
    assert out is None and res.exit_code == 11 and res.stderr is None
    out, res, _ = await _run((), data=data, t=True, x=("*",))
    assert out == b"Archive:  /a.zip\n" + ZERO_TESTED.format("/a.zip").encode()
    assert res.exit_code == 11


@pytest.mark.asyncio
async def test_x_excluded_member_still_counts_for_its_include():
    out, res, _ = await _run(
        ("dir/*",), data=_stored(MULTI), Z=True, args_1=True, x=("dir/a.txt",)
    )
    assert out == b"dir/\n"
    assert res.exit_code == 0
    assert res.stderr is None


@pytest.mark.asyncio
async def test_t_reports_both_caution_kinds_on_stdout():
    out, res, _ = await _run(
        ("nomatch",), data=_stored(MULTI), t=True, x=("b.txt",)
    )
    assert out == (
        b"Archive:  /a.zip\n"
        b"caution: filename not matched:  nomatch\n"
        b"caution: excluded filename not matched:  b.txt\n"
        b"At least one error was detected in /a.zip.\n"
    )
    assert res.exit_code == 11
    out, res, _ = await _run((), data=_stored(MULTI), t=True, x=("nomatch",))
    assert out == (
        b"Archive:  /a.zip\n"
        + MULTI_TESTED
        + b"caution: excluded filename not matched:  nomatch\n"
        b"No errors detected in /a.zip for the 3 files tested.\n"
    )
    assert res.exit_code == 0


@pytest.mark.asyncio
async def test_p_excludes_and_cautions_on_stderr():
    out, res, _ = await _run(
        (), data=_stored(MULTI), p=True, x=("dir/*", "nomatch")
    )
    assert out == b"b"
    assert res.exit_code == 0
    assert _stderr_text(res) == (
        "caution: excluded filename not matched:  nomatch\n"
    )


def _read_only_unzip_mount() -> tuple[Workspace, RAMVFS]:
    vfs = RAMVFS()
    vfs._store.files["/a.zip"] = _zip_entries((("f.txt", b"hello\n"),))
    return Workspace({"/ro/": (vfs, MountMode.READ)}), vfs


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "unzip -t /ro/a.zip",
        "unzip -p /ro/a.zip f.txt",
    ],
)
async def test_a_read_only_mount_runs_unzip_where_it_writes_nothing(line: str):
    ws, vfs = _read_only_unzip_mount()
    before = dict(vfs._store.files)
    result = await ws.shell(line)
    await result.materialize_stdout()
    assert result.exit_code == 0
    assert vfs._store.files == before


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,code,stdout,stderr",
    [
        (
            "cd /ro && unzip a.zip",
            50,
            b"Archive:  a.zip\n",
            b"error:  cannot create f.txt\n        Read-only file system\n",
        ),
        (
            "unzip -d /ro/out /ro/a.zip",
            2,
            b"Archive:  /ro/a.zip\n",
            b"checkdir:  cannot create extraction directory: /ro/out\n"
            b"           Read-only file system\n",
        ),
    ],
)
async def test_a_read_only_mount_refuses_unzip_at_the_write(
    line: str, code: int, stdout: bytes, stderr: bytes
):
    # UnZip 6.00 on a read-only filesystem: a member it cannot create is
    # named as it would have made it (exit 50), an extraction directory it
    # cannot make ends the run (exit 2).
    ws, vfs = _read_only_unzip_mount()
    before = dict(vfs._store.files)
    result = await ws.shell(line)
    assert (
        result.exit_code,
        await result.materialize_stdout(),
        result.stderr,
    ) == (code, stdout, stderr)
    assert vfs._store.files == before


@pytest.mark.asyncio
async def test_a_refused_probe_still_reports_the_entry_and_goes_on():
    """A stat refused while naming the level in the way ends no run.

    The level a member needs cannot be searched, so its mkdir fails and
    so does the stat that looks for a file in the way; Info-ZIP reports
    the member with a checkdir error, extracts the next one and exits 2.
    """
    data = _zip_entries((("sec/a.txt", b"A"), ("ok.txt", b"OK")))
    recorder = _Recorder()

    async def stat(path: PathSpec) -> FileStat:
        if path.virtual.startswith("/out/sec"):
            raise PermissionError(errno.EACCES, "Permission denied")
        if path.virtual == "/out":
            return FileStat(name="out", type=FileType.DIRECTORY)
        raise FileNotFoundError(errno.ENOENT, "No such file or directory")

    async def mkdir(_p: PathSpec, parents: bool = False) -> None:
        raise PermissionError(errno.EACCES, "Permission denied")

    _, res = await unzip(
        _archive(),
        read_bytes=_Reader(data),
        write_bytes=recorder,
        mkdir_fn=mkdir,
        stat=stat,
        d="/out",
        q=True,
    )
    assert recorder.written == {"/out/ok.txt": b"OK"}
    assert res.exit_code == 2
    assert _stderr_text(res).endswith("unable to process sec/a.txt.\n")
