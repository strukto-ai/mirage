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

from functools import partial

import pytest

from mirage.commands.builtin.rg_helper import rg_full, rg_matches_filter
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat, to_pathspec)
from mirage.core.ram.mkdir import mkdir
from mirage.core.ram.read import read
from mirage.core.ram.readdir import readdir
from mirage.core.ram.stat import stat
from mirage.core.ram.write import write_bytes as _async_write_bytes


async def _write(backend, path, content):
    accessor = backend.accessor
    await _async_write_bytes(accessor, to_pathspec(path), content.encode())


async def _mkdir(backend, path):
    accessor = backend.accessor
    await mkdir(accessor, to_pathspec(path), parents=True)


def _bind(backend):
    accessor = backend.accessor
    backend.index
    return (
        partial(call_readdir, partial(readdir, accessor)),
        partial(call_stat, partial(stat, accessor)),
        partial(call_read_bytes, partial(read, accessor)),
    )


async def rg(backend, path, pattern, **kwargs):
    rd, st, rb = _bind(backend)
    return await rg_full(
        rd,
        st,
        rb,
        path,
        pattern,
        ignore_case=kwargs.get("ignore_case", False),
        invert=kwargs.get("invert", False),
        line_numbers=kwargs.get("line_numbers", True),
        count_only=kwargs.get("count_only", False),
        files_only=kwargs.get("files_only", False),
        fixed_string=kwargs.get("fixed_string", False),
        only_matching=kwargs.get("only_matching", False),
        max_count=kwargs.get("max_count", None),
        whole_word=kwargs.get("whole_word", False),
        context_before=kwargs.get("context_before", 0),
        context_after=kwargs.get("context_after", 0),
        file_type=kwargs.get("file_type", None),
        glob_pattern=kwargs.get("glob_pattern", None),
        hidden=kwargs.get("hidden", False),
        warnings=kwargs.get("warnings", None),
    )


class TestRgMatchesFilter:

    def test_hidden_excluded(self):
        assert not rg_matches_filter(".hidden", None, None, False)

    def test_hidden_included(self):
        assert rg_matches_filter(".hidden", None, None, True)

    def test_file_type_match(self):
        assert rg_matches_filter("file.py", "py", None, False)

    def test_file_type_no_match(self):
        assert not rg_matches_filter("file.txt", "py", None, False)

    def test_glob_match(self):
        assert rg_matches_filter("file.py", None, "*.py", False)

    def test_glob_no_match(self):
        assert not rg_matches_filter("file.txt", None, "*.py", False)


class TestBasicMatching:

    @pytest.mark.anyio
    async def test_single_file_match(self, backend):
        await _write(backend, "/tmp/a.txt",
                     "hello world\nfoo bar\nhello again")
        result = await rg(backend, "/tmp/a.txt", "hello")
        assert result == ["1:hello world", "3:hello again"]

    @pytest.mark.anyio
    async def test_no_match(self, backend):
        await _write(backend, "/tmp/a.txt", "hello world\nfoo bar")
        result = await rg(backend, "/tmp/a.txt", "xyz")
        assert result == []


class TestRecursive:

    @pytest.mark.anyio
    async def test_recursive_default(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/a.txt", "hello")
        await _write(backend, "/tmp/sub/b.txt", "hello world")
        result = await rg(backend, "/tmp", "hello")
        assert any("/tmp/a.txt:" in r for r in result)
        assert any("/tmp/sub/b.txt:" in r for r in result)

    @pytest.mark.anyio
    async def test_recursive_with_line_numbers(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/sub/b.txt", "x\nhello\ny")
        result = await rg(backend, "/tmp", "hello")
        assert any("2:hello" in r for r in result)

    @pytest.mark.anyio
    async def test_recursive_no_match(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/a.txt", "foo")
        await _write(backend, "/tmp/sub/b.txt", "bar")
        result = await rg(backend, "/tmp", "xyz")
        assert result == []


class TestIgnoreCase:

    @pytest.mark.anyio
    async def test_ignore_case_matches(self, backend):
        await _write(backend, "/tmp/a.txt", "Hello World\nhello world\nHELLO")
        result = await rg(backend, "/tmp/a.txt", "hello", ignore_case=True)
        assert result == ["1:Hello World", "2:hello world", "3:HELLO"]

    @pytest.mark.anyio
    async def test_ignore_case_off(self, backend):
        await _write(backend, "/tmp/a.txt", "Hello World\nhello world\nHELLO")
        result = await rg(backend, "/tmp/a.txt", "hello", ignore_case=False)
        assert result == ["2:hello world"]


class TestInvert:

    @pytest.mark.anyio
    async def test_invert_match(self, backend):
        await _write(backend, "/tmp/a.txt", "hello\nworld\nhello again")
        result = await rg(backend, "/tmp/a.txt", "hello", invert=True)
        assert result == ["2:world"]

    @pytest.mark.anyio
    async def test_invert_all_match(self, backend):
        await _write(backend, "/tmp/a.txt", "hello\nhello again")
        result = await rg(backend, "/tmp/a.txt", "hello", invert=True)
        assert result == []


class TestLineNumbers:

    @pytest.mark.anyio
    async def test_line_numbers_default_true(self, backend):
        await _write(backend, "/tmp/a.txt", "foo\nbar\nfoo baz")
        result = await rg(backend, "/tmp/a.txt", "foo")
        assert result == ["1:foo", "3:foo baz"]

    @pytest.mark.anyio
    async def test_line_numbers_disabled(self, backend):
        await _write(backend, "/tmp/a.txt", "foo\nbar\nfoo baz")
        result = await rg(backend, "/tmp/a.txt", "foo", line_numbers=False)
        assert result == ["foo", "foo baz"]


class TestCountOnly:

    @pytest.mark.anyio
    async def test_count_only(self, backend):
        await _write(backend, "/tmp/a.txt", "foo\nbar\nfoo baz")
        result = await rg(backend, "/tmp/a.txt", "foo", count_only=True)
        assert result == ["2"]

    @pytest.mark.anyio
    async def test_count_only_zero(self, backend):
        await _write(backend, "/tmp/a.txt", "bar\nbaz")
        result = await rg(backend, "/tmp/a.txt", "foo", count_only=True)
        assert result == []


class TestFilesOnly:

    @pytest.mark.anyio
    async def test_files_only_match(self, backend):
        await _write(backend, "/tmp/a.txt", "foo\nbar")
        result = await rg(backend, "/tmp/a.txt", "foo", files_only=True)
        assert result == ["/tmp/a.txt"]

    @pytest.mark.anyio
    async def test_files_only_no_match(self, backend):
        await _write(backend, "/tmp/a.txt", "bar\nbaz")
        result = await rg(backend, "/tmp/a.txt", "foo", files_only=True)
        assert result == []

    @pytest.mark.anyio
    async def test_files_only_recursive(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/a.txt", "hello")
        await _write(backend, "/tmp/sub/b.txt", "world")
        result = await rg(backend, "/tmp", "hello", files_only=True)
        assert "/tmp/a.txt" in result
        assert "/tmp/sub/b.txt" not in result


class TestFixedString:

    @pytest.mark.anyio
    async def test_fixed_string_dots(self, backend):
        await _write(backend, "/tmp/a.txt", "a.b\nacb\na*b")
        result = await rg(backend, "/tmp/a.txt", "a.b", fixed_string=True)
        assert result == ["1:a.b"]

    @pytest.mark.anyio
    async def test_fixed_string_star(self, backend):
        await _write(backend, "/tmp/a.txt", "a*b\nacb\nab")
        result = await rg(backend, "/tmp/a.txt", "a*b", fixed_string=True)
        assert result == ["1:a*b"]


class TestWholeWord:

    @pytest.mark.anyio
    async def test_whole_word_matches(self, backend):
        await _write(backend, "/tmp/a.txt", "foo\nfoobar\nfoo baz")
        result = await rg(backend, "/tmp/a.txt", "foo", whole_word=True)
        assert result == ["1:foo", "3:foo baz"]

    @pytest.mark.anyio
    async def test_whole_word_no_match(self, backend):
        await _write(backend, "/tmp/a.txt", "foobar\nbarfoo")
        result = await rg(backend, "/tmp/a.txt", "foo", whole_word=True)
        assert result == []


class TestOnlyMatching:

    @pytest.mark.anyio
    async def test_only_matching(self, backend):
        await _write(backend, "/tmp/a.txt", "hello world\nfoo hello bar")
        result = await rg(backend, "/tmp/a.txt", "hello", only_matching=True)
        assert result == ["1:hello", "2:hello"]

    @pytest.mark.anyio
    async def test_only_matching_regex(self, backend):
        await _write(backend, "/tmp/a.txt", "abc123def\nno digits here")
        result = await rg(backend, "/tmp/a.txt", r"\d+", only_matching=True)
        assert result == ["1:123"]


class TestMaxCount:

    @pytest.mark.anyio
    async def test_max_count_limits(self, backend):
        await _write(backend, "/tmp/a.txt", "foo\nfoo\nfoo\nfoo")
        result = await rg(backend, "/tmp/a.txt", "foo", max_count=2)
        assert result == ["1:foo", "2:foo"]

    @pytest.mark.anyio
    async def test_max_count_more_than_matches(self, backend):
        await _write(backend, "/tmp/a.txt", "foo\nbar\nfoo")
        result = await rg(backend, "/tmp/a.txt", "foo", max_count=10)
        assert result == ["1:foo", "3:foo"]


class TestFileType:

    @pytest.mark.anyio
    async def test_file_type_py(self, backend):
        await _mkdir(backend, "/tmp/src")
        await _write(backend, "/tmp/src/a.py", "hello")
        await _write(backend, "/tmp/src/b.txt", "hello")
        result = await rg(backend, "/tmp", "hello", file_type="py")
        assert any("a.py" in r for r in result)
        assert not any("b.txt" in r for r in result)

    @pytest.mark.anyio
    async def test_file_type_no_match(self, backend):
        await _mkdir(backend, "/tmp/src")
        await _write(backend, "/tmp/src/a.txt", "hello")
        result = await rg(backend, "/tmp", "hello", file_type="py")
        assert result == []

    @pytest.mark.anyio
    async def test_file_type_single_file(self, backend):
        await _write(backend, "/tmp/a.txt", "hello")
        result = await rg(backend, "/tmp/a.txt", "hello", file_type="py")
        assert result == []


class TestGlobPattern:

    @pytest.mark.anyio
    async def test_glob_pattern_match(self, backend):
        await _mkdir(backend, "/tmp/src")
        await _write(backend, "/tmp/src/a.py", "hello")
        await _write(backend, "/tmp/src/b.txt", "hello")
        result = await rg(backend, "/tmp", "hello", glob_pattern="*.py")
        assert any("a.py" in r for r in result)
        assert not any("b.txt" in r for r in result)

    @pytest.mark.anyio
    async def test_glob_pattern_no_match(self, backend):
        await _mkdir(backend, "/tmp/src")
        await _write(backend, "/tmp/src/a.txt", "hello")
        result = await rg(backend, "/tmp", "hello", glob_pattern="*.py")
        assert result == []


class TestHidden:

    @pytest.mark.anyio
    async def test_hidden_files_excluded_by_default(self, backend):
        await _write(backend, "/tmp/.hidden.txt", "hello")
        await _write(backend, "/tmp/visible.txt", "hello")
        result = await rg(backend, "/tmp", "hello")
        assert not any(".hidden" in r for r in result)
        assert any("visible" in r for r in result)

    @pytest.mark.anyio
    async def test_hidden_files_included(self, backend):
        await _write(backend, "/tmp/.hidden.txt", "hello")
        await _write(backend, "/tmp/visible.txt", "hello")
        result = await rg(backend, "/tmp", "hello", hidden=True)
        assert any(".hidden" in r for r in result)
        assert any("visible" in r for r in result)

    @pytest.mark.anyio
    async def test_hidden_dirs_excluded_by_default(self, backend):
        await _mkdir(backend, "/tmp/.hdir")
        await _write(backend, "/tmp/.hdir/a.txt", "hello")
        result = await rg(backend, "/tmp", "hello")
        assert not any(".hdir" in r for r in result)

    @pytest.mark.anyio
    async def test_hidden_dirs_included(self, backend):
        await _mkdir(backend, "/tmp/.hdir")
        await _write(backend, "/tmp/.hdir/a.txt", "hello")
        result = await rg(backend, "/tmp", "hello", hidden=True)
        assert any(".hdir" in r for r in result)


class TestMixedFlags:

    @pytest.mark.anyio
    async def test_ignore_case_with_count(self, backend):
        await _write(backend, "/tmp/a.txt", "Hello\nhello\nHELLO\nworld")
        result = await rg(backend,
                          "/tmp/a.txt",
                          "hello",
                          ignore_case=True,
                          count_only=True)
        assert result == ["3"]

    @pytest.mark.anyio
    async def test_fixed_string_with_ignore_case(self, backend):
        await _write(backend, "/tmp/a.txt", "A.B\na.b\nacb")
        result = await rg(backend,
                          "/tmp/a.txt",
                          "a.b",
                          fixed_string=True,
                          ignore_case=True)
        assert result == ["1:A.B", "2:a.b"]

    @pytest.mark.anyio
    async def test_invert_with_line_numbers(self, backend):
        await _write(backend, "/tmp/a.txt", "foo\nbar\nbaz")
        result = await rg(backend, "/tmp/a.txt", "bar", invert=True)
        assert result == ["1:foo", "3:baz"]


class TestWarnings:

    @pytest.mark.anyio
    async def test_warnings_on_missing_file(self, backend):
        warnings = []
        result = await rg(backend,
                          "/tmp/nonexistent.txt",
                          "foo",
                          warnings=warnings)
        assert result == []

    @pytest.mark.anyio
    async def test_warnings_none_does_not_error(self, backend):
        result = await rg(backend,
                          "/tmp/nonexistent.txt",
                          "foo",
                          warnings=None)
        assert result == []

    @pytest.mark.anyio
    async def test_warnings_on_missing_directory(self, backend):
        warnings = []
        result = await rg(backend, "/tmp/nodir", "foo", warnings=warnings)
        assert result == []
