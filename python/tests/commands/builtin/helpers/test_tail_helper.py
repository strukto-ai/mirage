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

from mirage.commands.builtin.tail_helper import number_flag_error
from mirage.commands.builtin.tail_helper import tail as _tail_impl


class TestNumberFlagError:

    def test_valid_numbers_pass(self):
        assert number_flag_error("head", "5", None) is None
        assert number_flag_error("tail", "+3", None) is None
        assert number_flag_error("head", None, "-2") is None

    def test_invalid_lines(self):
        assert number_flag_error(
            "head", "abc", None) == "head: invalid number of lines: 'abc'\n"

    def test_invalid_bytes(self):
        assert number_flag_error(
            "tail", None, "xyz") == "tail: invalid number of bytes: 'xyz'\n"


def _norm(path):
    return "/" + path.strip("/")


def _write(backend, path, data):
    backend.accessor.store.files[_norm(path)] = data


def _read(backend, path):
    return backend.accessor.store.files[_norm(path)]


def tail(backend, path, **kwargs):
    return _tail_impl(lambda p: _read(backend, p), path, **kwargs)


TWENTY_LINES = b"\n".join(f"line{i}".encode() for i in range(1, 21))


class TestTailDefault:

    def test_returns_last_10_lines(self, backend):
        _write(backend, "/tmp/f.txt", TWENTY_LINES)
        result = tail(backend, "/tmp/f.txt")
        expected = b"\n".join(f"line{i}".encode() for i in range(11, 21))
        assert result == expected


class TestTailCustomLines:

    def test_n3(self, backend):
        _write(backend, "/tmp/f.txt", TWENTY_LINES)
        result = tail(backend, "/tmp/f.txt", lines=3)
        expected = b"\n".join(f"line{i}".encode() for i in range(18, 21))
        assert result == expected

    def test_n1(self, backend):
        _write(backend, "/tmp/f.txt", TWENTY_LINES)
        result = tail(backend, "/tmp/f.txt", lines=1)
        assert result == b"line20"

    def test_n_larger_than_file(self, backend):
        data = b"a\nb\nc"
        _write(backend, "/tmp/f.txt", data)
        result = tail(backend, "/tmp/f.txt", lines=100)
        assert result == data


class TestTailBytesMode:

    def test_specific_bytes(self, backend):
        _write(backend, "/tmp/f.txt", b"abcdefghij")
        result = tail(backend, "/tmp/f.txt", bytes_mode=5)
        assert result == b"fghij"

    def test_bytes_larger_than_file(self, backend):
        _write(backend, "/tmp/f.txt", b"abc")
        result = tail(backend, "/tmp/f.txt", bytes_mode=100)
        assert result == b"abc"

    def test_zero_bytes(self, backend):
        _write(backend, "/tmp/f.txt", b"abc")
        result = tail(backend, "/tmp/f.txt", bytes_mode=0)
        assert result == b""


class TestTailEdgeCases:

    def test_empty_file(self, backend):
        _write(backend, "/tmp/f.txt", b"")
        result = tail(backend, "/tmp/f.txt")
        assert result == b""

    def test_single_line_no_newline(self, backend):
        _write(backend, "/tmp/f.txt", b"hello")
        result = tail(backend, "/tmp/f.txt")
        assert result == b"hello"
