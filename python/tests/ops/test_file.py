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
import io

import pytest

from mirage.ops.file import MirageFile

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

    @pytest.mark.parametrize("mode", ["", "rw", "rr", "r++", "rbt"])
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

    def test_flush_persists_before_close(self):
        ops, _ = make_ops_with_dir()
        f = MirageFile(ops, "/data/dir/f.txt", "w")
        f.write("visible")
        f.flush()
        assert _read(ops, "/data/dir/f.txt") == b"visible"
        f.close()

    def test_exclusive_mode_creates_once(self):
        ops, _ = make_ops_with_dir()
        with MirageFile(ops, "/data/dir/f.txt", "x") as f:
            f.write("new")
        assert _read(ops, "/data/dir/f.txt") == b"new"
        with pytest.raises(FileExistsError):
            MirageFile(ops, "/data/dir/f.txt", "x")

    def test_append_mode_creates_missing_file_on_open(self):
        ops, _ = make_ops_with_dir()
        f = MirageFile(ops, "/data/dir/f.txt", "a")
        assert _read(ops, "/data/dir/f.txt") == b""
        f.close()

    def test_text_encoding_and_error_policy_are_honored(self):
        ops, _ = make_ops_with_dir()
        _write(ops, "/data/dir/f.txt", b"caf\xe9")
        with MirageFile(ops,
                        "/data/dir/f.txt",
                        encoding="ascii",
                        errors="replace") as f:
            assert f.read() == "caf�"

    @pytest.mark.parametrize("argument", ["encoding", "errors", "newline"])
    def test_binary_mode_rejects_text_arguments(self, argument):
        ops, _ = make_ops_with_dir()
        with pytest.raises(ValueError, match="binary mode"):
            MirageFile(ops, "/data/dir/f.txt", "rb", **{argument: "utf-8"})
