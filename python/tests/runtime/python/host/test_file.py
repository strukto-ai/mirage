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

import asyncio
import errno
import io

import pytest

from mirage import MountMode, Workspace
from mirage.ops.registry import op
from mirage.runtime.handles.constants import READ_CHUNK
from mirage.runtime.python.host.file import MirageFile
from mirage.types import PathSpec
from mirage.vfs.ram import RAMVFS

from .conftest import make_ops_with_dir


def _write(ops, path, data):
    asyncio.run(ops.write(path, data))


def _read(ops, path):
    return asyncio.run(ops.read(path))


class TestMirageFile:
    def test_read_text(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"hello")
        f = MirageFile(ops, "/data/dir/f.txt", "r")
        assert f.read() == "hello"
        f.close()

    def test_read_binary(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.bin", b"\x00\x01\x02")
        f = MirageFile(ops, "/data/dir/f.bin", "rb")
        assert f.read() == b"\x00\x01\x02"
        f.close()

    def test_write_text(self):
        ops, _ = make_ops_with_dir()
        f = MirageFile(ops, "/data/dir/out.txt", "w")
        f.write("written")
        f.close()
        assert _read(ops, "/data/dir/out.txt") == b"written"

    def test_write_binary(self):
        ops, _ = make_ops_with_dir()
        f = MirageFile(ops, "/data/dir/out.bin", "wb")
        f.write(b"\xff\xfe")
        f.close()
        assert _read(ops, "/data/dir/out.bin") == b"\xff\xfe"

    def test_context_manager(self):
        ops, _ = make_ops_with_dir()
        with MirageFile(ops, "/data/dir/ctx.txt", "w") as f:
            f.write("ctx")
        assert _read(ops, "/data/dir/ctx.txt") == b"ctx"

    def test_append(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/app.txt", b"hello")
        with MirageFile(ops, "/data/dir/app.txt", "a") as f:
            f.write(" world")
        assert _read(ops, "/data/dir/app.txt") == b"hello world"

    def test_readline(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/lines.txt", b"line1\nline2\nline3")
        f = MirageFile(ops, "/data/dir/lines.txt", "r")
        assert f.readline() == "line1\n"
        assert f.readline() == "line2\n"
        f.close()

    def test_iter(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/iter.txt", b"a\nb\nc")
        f = MirageFile(ops, "/data/dir/iter.txt", "r")
        lines = list(f)
        assert lines == ["a\n", "b\n", "c"]
        f.close()

    def test_seek_tell(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/seek.txt", b"abcdef")
        f = MirageFile(ops, "/data/dir/seek.txt", "rb")
        f.seek(3)
        assert f.tell() == 3
        assert f.read() == b"def"
        f.close()

    def test_properties(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/p.txt", b"data")
        f = MirageFile(ops, "/data/dir/p.txt", "r")
        assert f.name == "/data/dir/p.txt"
        assert f.mode == "r"
        assert f.readable() is True
        assert f.writable() is False
        assert f.closed is False
        f.close()
        assert f.closed is True

    def test_write_rejects_read_only_mode(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"original")
        f = MirageFile(ops, "/data/dir/f.txt", "r")
        with pytest.raises(io.UnsupportedOperation, match="not writable"):
            f.write("replacement")
        f.close()
        assert _read(ops, "/data/dir/f.txt") == b"original"

    def test_read_rejects_write_only_mode(self):
        ops, _ = make_ops_with_dir()
        f = MirageFile(ops, "/data/dir/f.txt", "w")
        with pytest.raises(io.UnsupportedOperation, match="not readable"):
            f.read()
        f.close()

    def test_operations_reject_closed_file(self):
        ops, _ = make_ops_with_dir()
        f = MirageFile(ops, "/data/dir/f.txt", "w")
        f.close()
        with pytest.raises(ValueError, match="closed file"):
            f.write("late")

    @pytest.mark.parametrize("mode", ["", "rw", "rr", "wx", "r++", "rbt"])
    def test_invalid_mode_is_rejected(self, mode):
        ops, _ = make_ops_with_dir()
        with pytest.raises(ValueError, match="invalid mode"):
            MirageFile(ops, "/data/dir/f.txt", mode)

    def test_write_mode_truncates_when_opened(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"original")
        f = MirageFile(ops, "/data/dir/f.txt", "w")
        assert _read(ops, "/data/dir/f.txt") == b""
        f.close()

    def test_update_mode_persists_writes(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"original")
        with MirageFile(ops, "/data/dir/f.txt", "r+") as f:
            f.write("changed")
        assert _read(ops, "/data/dir/f.txt") == b"changedl"

    def test_w_plus_truncates_at_open_and_reads_back_its_writes(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"original")
        with MirageFile(ops, "/data/dir/f.txt", "w+") as f:
            assert _read(ops, "/data/dir/f.txt") == b""
            f.write("fresh")
            f.seek(0)
            assert f.read() == "fresh"
        assert _read(ops, "/data/dir/f.txt") == b"fresh"

    def test_a_plus_writes_at_the_end_after_a_seek(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"one\n")
        with MirageFile(ops, "/data/dir/f.txt", "a+") as f:
            f.seek(0)
            assert f.read() == "one\n"
            f.seek(0)
            f.write("two\n")
            f.seek(0)
            assert f.read() == "one\ntwo\n"
        assert _read(ops, "/data/dir/f.txt") == b"one\ntwo\n"

    def test_flush_persists_before_close(self):
        ops, _ = make_ops_with_dir()
        f = MirageFile(ops, "/data/dir/f.txt", "w")
        f.write("visible")
        f.flush()
        assert _read(ops, "/data/dir/f.txt") == b"visible"
        f.close()

    def test_exclusive_mode_creates_once(self):
        mode = "x"
        ops, _ = make_ops_with_dir()
        with MirageFile(ops, "/data/dir/f.txt", mode) as f:
            f.write("new")
        assert _read(ops, "/data/dir/f.txt") == b"new"
        with pytest.raises(FileExistsError):
            MirageFile(ops, "/data/dir/f.txt", mode)
        assert _read(ops, "/data/dir/f.txt") == b"new"

    def test_exclusive_mode_refuses_a_dangling_link(self):
        # O_CREAT|O_EXCL follows no link, so the link's own name is
        # there even though its target is not; creating through it would
        # put a file at the target the open never named.
        ops, _ = make_ops_with_dir()
        asyncio.run(ops.symlink("/data/dir/lnk", "/data/dir/gone"))
        with pytest.raises(FileExistsError):
            MirageFile(ops, "/data/dir/lnk", "x")
        with pytest.raises(FileNotFoundError):
            _read(ops, "/data/dir/gone")

    def test_a_write_mode_refuses_a_directory(self):
        ops, _ = make_ops_with_dir()
        with pytest.raises(IsADirectoryError):
            MirageFile(ops, "/data/dir", "w")
        assert asyncio.run(ops.is_dir("/data/dir"))

    def test_a_read_of_a_missing_file_fails_at_open(self):
        # CPython raises at open, not at the first read.
        ops, _ = make_ops_with_dir()
        with pytest.raises(FileNotFoundError):
            MirageFile(ops, "/data/dir/nope.txt", "r")

    def test_a_create_under_a_missing_directory_carries_its_errno(self):
        # The backend raises a bare FileNotFoundError; the door numbers it
        # as open(2) would, so `except OSError as e: e.errno` holds.
        ops, _ = make_ops_with_dir()
        with pytest.raises(FileNotFoundError) as caught:
            MirageFile(ops, "/data/dir/nope/f.txt", "w")
        assert caught.value.errno == errno.ENOENT

    def test_append_mode_creates_missing_file_on_open(self):
        ops, _ = make_ops_with_dir()
        f = MirageFile(ops, "/data/dir/f.txt", "a")
        assert _read(ops, "/data/dir/f.txt") == b""
        f.close()

    def test_text_encoding_and_error_policy_are_honored(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"caf\xe9")
        with MirageFile(
            ops, "/data/dir/f.txt", encoding="ascii", errors="replace"
        ) as f:
            assert f.read() == "caf�"

    def test_the_locale_encoding_sentinel_is_not_a_codec_name(self):
        # What `pathlib.read_text()` passes on any interpreter that is
        # not in UTF-8 mode: io.open reads it as "the platform default",
        # and looking it up as a codec raises LookupError.
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", "caf\u00e9".encode())
        with MirageFile(ops, "/data/dir/f.txt", encoding="locale") as f:
            assert f.read() == "caf\u00e9"

    def test_the_locale_sentinel_writes_the_same_bytes_as_the_default(self):
        ops, _ = make_ops_with_dir()
        with MirageFile(ops, "/data/dir/f.txt", "w", encoding="locale") as f:
            f.write("caf\u00e9")
        assert _read(ops, "/data/dir/f.txt") == "caf\u00e9".encode()

    @pytest.mark.parametrize("argument", ["encoding", "errors", "newline"])
    def test_binary_mode_rejects_text_arguments(self, argument):
        ops, _ = make_ops_with_dir()
        with pytest.raises(ValueError, match="binary mode"):
            MirageFile(ops, "/data/dir/f.txt", "rb", **{argument: "utf-8"})


@op("read", vfs="ram", filetype=".tally")
async def _read_tally(accessor, path: PathSpec, **kwargs) -> bytes:
    return b"RENDERED"


class TestChunks:
    def test_a_read_only_open_moves_only_the_chunk_it_reads(self):
        # Reading a few bytes of a large file used to fetch all of it.
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/big.txt", b"x" * (3 * READ_CHUNK))
        before = len(ops.records)
        with MirageFile(ops, "/data/dir/big.txt", "r") as f:
            assert f.read(5) == "xxxxx"
        moved = [r.bytes for r in ops.records[before:] if r.op == "read"]
        assert moved == [READ_CHUNK]

    def test_lines_across_chunks_read_as_the_file_holds_them(self):
        ops, _ = make_ops_with_dir()
        body = b"".join(b"line %d\n" % i for i in range(300_000))
        _write(ops, "/data/dir/lines.txt", body)
        with MirageFile(ops, "/data/dir/lines.txt", "r") as f:
            assert list(f) == body.decode().splitlines(keepends=True)
        with MirageFile(ops, "/data/dir/lines.txt", "rb") as f:
            f.seek(-7, 2)
            assert f.read() == b"299999\n"[-7:]

    def test_a_writable_open_starts_from_the_stored_bytes(self):
        # Its flush stores what it holds, so starting from the rendering
        # stored the rendering over the file.
        ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
        ws.mount("/data/").register_fns([_read_tally])
        _write(ws.vfs, "/data/books.tally", b"STORED")
        with MirageFile(ws.vfs, "/data/books.tally", "r") as f:
            assert f.read() == "RENDERED"
        with MirageFile(ws.vfs, "/data/books.tally", "a") as f:
            f.write("+")
        assert asyncio.run(ws.vfs.read("/data/books.tally", raw=True)) == (
            b"STORED+"
        )
