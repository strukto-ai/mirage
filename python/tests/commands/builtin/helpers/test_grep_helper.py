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

from mirage.commands.builtin.grep_helper import (compile_pattern,
                                                 get_extension,
                                                 grep_files_only, grep_lines,
                                                 grep_recursive)
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
    index = backend.index
    return (
        partial(call_readdir, readdir, accessor, index=index),
        partial(call_stat, stat, accessor),
        partial(call_read_bytes, read, accessor),
    )


async def grep(backend, path, pattern, **kwargs):
    rd, st, rb = _bind(backend)
    recursive = kwargs.pop("recursive", False)
    ignore_case = kwargs.pop("ignore_case", False)
    invert = kwargs.pop("invert", False)
    line_numbers = kwargs.pop("line_numbers", False)
    count_only = kwargs.pop("count_only", False)
    files_only = kwargs.pop("files_only", False)
    fixed_string = kwargs.pop("fixed_string", False)
    only_matching = kwargs.pop("only_matching", False)
    max_count = kwargs.pop("max_count", None)
    whole_word = kwargs.pop("whole_word", False)
    show_filename = kwargs.pop("show_filename", None)
    warnings = kwargs.pop("warnings", None)

    compiled = compile_pattern(pattern, ignore_case, fixed_string, whole_word)

    if recursive:
        results = await grep_recursive(
            rd,
            st,
            rb,
            path,
            compiled,
            invert,
            line_numbers,
            count_only,
            files_only,
            only_matching,
            max_count,
            warnings,
        )
        if show_filename is False and not count_only and not files_only:
            stripped = []
            for r in results:
                colon_idx = r.find(":")
                stripped.append(r[colon_idx + 1:] if colon_idx != -1 else r)
            return stripped
        return results

    return await grep_files_only(
        rd,
        st,
        rb,
        path,
        pattern,
        recursive=False,
        ignore_case=ignore_case,
        invert=invert,
        line_numbers=line_numbers,
        count_only=count_only,
        fixed_string=fixed_string,
        only_matching=only_matching,
        max_count=max_count,
        whole_word=whole_word,
        warnings=warnings,
    )


class TestCompilePattern:

    def test_basic(self):
        pat = compile_pattern("hello")
        assert pat.search("hello world")

    def test_ignore_case(self):
        pat = compile_pattern("hello", ignore_case=True)
        assert pat.search("HELLO")

    def test_fixed_string(self):
        pat = compile_pattern("a.b", fixed_string=True)
        assert not pat.search("axb")
        assert pat.search("a.b")

    def test_whole_word(self):
        pat = compile_pattern("foo", whole_word=True)
        assert not pat.search("foobar")
        assert pat.search("foo bar")


class TestGetExtension:

    def test_normal(self):
        assert get_extension("file.txt") == ".txt"

    def test_no_ext(self):
        assert get_extension("file") is None

    def test_directory_dot(self):
        assert get_extension("dir.d/file") is None


class TestGrepLines:

    def test_basic(self):
        compiled = compile_pattern("hello")
        result = grep_lines("/f.txt", ["hello world", "foo"], compiled, False,
                            False, False, False, False, None)
        assert result == ["hello world"]


class TestBasicMatching:

    @pytest.mark.anyio
    async def test_match_found(self, backend):
        await _write(backend, "/tmp/a.txt",
                     "hello world\nfoo bar\nhello again")
        result = await grep(backend, "/tmp/a.txt", "hello")
        assert result == ["/tmp/a.txt"]

    @pytest.mark.anyio
    async def test_no_match(self, backend):
        await _write(backend, "/tmp/a.txt", "hello world\nfoo bar")
        result = await grep(backend, "/tmp/a.txt", "xyz")
        assert result == []

    @pytest.mark.anyio
    async def test_empty_file(self, backend):
        await _write(backend, "/tmp/a.txt", "")
        result = await grep(backend, "/tmp/a.txt", "hello")
        assert result == []


class TestIgnoreCase:

    @pytest.mark.anyio
    async def test_ignore_case_matches(self, backend):
        await _write(backend, "/tmp/a.txt", "Hello World\nhello world\nHELLO")
        result = await grep(backend,
                            "/tmp/a.txt",
                            "hello",
                            ignore_case=True,
                            files_only=True)
        assert result == ["/tmp/a.txt"]


class TestInvert:

    @pytest.mark.anyio
    async def test_invert_match(self, backend):
        await _write(backend, "/tmp/a.txt", "hello\nworld\nhello again")
        result = await grep(backend,
                            "/tmp/a.txt",
                            "hello",
                            invert=True,
                            files_only=True)
        assert result == ["/tmp/a.txt"]


class TestCountOnly:

    @pytest.mark.anyio
    async def test_count_only(self, backend):
        await _write(backend, "/tmp/a.txt", "foo\nbar\nfoo baz")
        result = await grep(backend, "/tmp/a.txt", "foo", count_only=True)
        assert result == ["2"]


class TestRecursive:

    @pytest.mark.anyio
    async def test_recursive_basic(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/a.txt", "hello")
        await _write(backend, "/tmp/sub/b.txt", "hello world")
        result = await grep(backend, "/tmp", "hello", recursive=True)
        assert "/tmp/a.txt:hello" in result
        assert "/tmp/sub/b.txt:hello world" in result

    @pytest.mark.anyio
    async def test_recursive_with_line_numbers(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/sub/b.txt", "x\nhello\ny")
        result = await grep(backend,
                            "/tmp",
                            "hello",
                            recursive=True,
                            line_numbers=True)
        assert "/tmp/sub/b.txt:2:hello" in result

    @pytest.mark.anyio
    async def test_recursive_with_files_only(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/a.txt", "hello")
        await _write(backend, "/tmp/sub/b.txt", "world")
        result = await grep(backend,
                            "/tmp",
                            "hello",
                            recursive=True,
                            files_only=True)
        assert "/tmp/a.txt" in result
        assert "/tmp/sub/b.txt" not in result

    @pytest.mark.anyio
    async def test_recursive_with_count_only(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/a.txt", "hello\nhello")
        await _write(backend, "/tmp/sub/b.txt", "hello")
        result = await grep(backend,
                            "/tmp",
                            "hello",
                            recursive=True,
                            count_only=True)
        assert len(result) > 0


class TestMixedFlags:

    @pytest.mark.anyio
    async def test_recursive_ignore_case_line_numbers(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/sub/a.txt", "Hello\nworld")
        result = await grep(backend,
                            "/tmp",
                            "hello",
                            recursive=True,
                            ignore_case=True,
                            line_numbers=True)
        assert "/tmp/sub/a.txt:1:Hello" in result


class TestShowFilename:

    @pytest.mark.anyio
    async def test_grep_hide_filename_recursive(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/sub/a.txt", "needle")
        result = await grep(backend,
                            "/tmp/sub/",
                            "needle",
                            recursive=True,
                            show_filename=False)
        assert result == ["needle"]


class TestWarnings:

    @pytest.mark.anyio
    async def test_warnings_on_missing_file(self, backend):
        warnings = []
        result = await grep(backend,
                            "/tmp/nonexistent.txt",
                            "foo",
                            warnings=warnings)
        assert result == []
        assert len(warnings) > 0
        assert "nonexistent" in warnings[0]

    @pytest.mark.anyio
    async def test_warnings_none_does_not_error(self, backend):
        result = await grep(backend,
                            "/tmp/nonexistent.txt",
                            "foo",
                            warnings=None)
        assert result == []
