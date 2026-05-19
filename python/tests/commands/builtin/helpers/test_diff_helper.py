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

from mirage.commands.builtin.diff_helper import diff as _diff_impl


def _norm(path):
    return "/" + path.strip("/")


def _write(backend, path, data):
    backend.accessor.store.files[_norm(path)] = data


def _read(backend, path):
    return backend.accessor.store.files[_norm(path)]


def diff(backend, path_a, path_b, **kwargs):
    return _diff_impl(lambda p: _read(backend, p), path_a, path_b, **kwargs)


class TestIdentical:

    def test_identical_files_empty_result(self, backend):
        _write(backend, "/tmp/a.txt", b"hello\nworld\n")
        _write(backend, "/tmp/b.txt", b"hello\nworld\n")
        result = diff(backend, "/tmp/a.txt", "/tmp/b.txt")
        assert result == []

    def test_identical_empty_files(self, backend):
        _write(backend, "/tmp/a.txt", b"")
        _write(backend, "/tmp/b.txt", b"")
        result = diff(backend, "/tmp/a.txt", "/tmp/b.txt")
        assert result == []


class TestDifferent:

    def test_different_files_normal_format(self, backend):
        _write(backend, "/tmp/a.txt", b"hello\n")
        _write(backend, "/tmp/b.txt", b"world\n")
        result = diff(backend, "/tmp/a.txt", "/tmp/b.txt")
        assert len(result) > 0
        texts = "".join(result)
        assert "< hello" in texts
        assert "> world" in texts


class TestIgnoreCase:

    def test_ignore_case_makes_identical(self, backend):
        _write(backend, "/tmp/a.txt", b"Hello\n")
        _write(backend, "/tmp/b.txt", b"hello\n")
        result = diff(backend, "/tmp/a.txt", "/tmp/b.txt", ignore_case=True)
        assert result == []

    def test_without_ignore_case_shows_diff(self, backend):
        _write(backend, "/tmp/a.txt", b"Hello\n")
        _write(backend, "/tmp/b.txt", b"hello\n")
        result = diff(backend, "/tmp/a.txt", "/tmp/b.txt", ignore_case=False)
        assert len(result) > 0


class TestIgnoreWhitespace:

    def test_ignore_whitespace_makes_identical(self, backend):
        _write(backend, "/tmp/a.txt", b"hello world\n")
        _write(backend, "/tmp/b.txt", b"helloworld\n")
        result = diff(backend,
                      "/tmp/a.txt",
                      "/tmp/b.txt",
                      ignore_whitespace=True)
        assert result == []


class TestIgnoreSpaceChange:

    def test_ignore_space_change_makes_identical(self, backend):
        _write(backend, "/tmp/a.txt", b"hello  world\n")
        _write(backend, "/tmp/b.txt", b"hello world\n")
        result = diff(backend,
                      "/tmp/a.txt",
                      "/tmp/b.txt",
                      ignore_space_change=True)
        assert result == []


class TestEdScript:

    def test_ed_script_change(self, backend):
        _write(backend, "/tmp/a.txt", b"alpha\n")
        _write(backend, "/tmp/b.txt", b"beta\n")
        result = diff(backend, "/tmp/a.txt", "/tmp/b.txt", ed_script=True)
        texts = "".join(result)
        assert "c\n" in texts

    def test_ed_script_delete(self, backend):
        _write(backend, "/tmp/a.txt", b"line1\nline2\n")
        _write(backend, "/tmp/b.txt", b"line1\n")
        result = diff(backend, "/tmp/a.txt", "/tmp/b.txt", ed_script=True)
        texts = "".join(result)
        assert "d\n" in texts

    def test_ed_script_insert(self, backend):
        _write(backend, "/tmp/a.txt", b"line1\n")
        _write(backend, "/tmp/b.txt", b"line1\nline2\n")
        result = diff(backend, "/tmp/a.txt", "/tmp/b.txt", ed_script=True)
        texts = "".join(result)
        assert "a\n" in texts
        assert ".\n" in texts

    def test_ed_script_identical(self, backend):
        _write(backend, "/tmp/a.txt", b"same\n")
        _write(backend, "/tmp/b.txt", b"same\n")
        result = diff(backend, "/tmp/a.txt", "/tmp/b.txt", ed_script=True)
        assert result == []
