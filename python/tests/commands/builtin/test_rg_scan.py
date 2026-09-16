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

from mirage.commands.builtin.rg_scan import _rg_matches_filter, rg_full
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat, to_pathspec)
from mirage.core.ram.mkdir import mkdir
from mirage.core.ram.read import read
from mirage.core.ram.readdir import readdir
from mirage.core.ram.stat import stat
from mirage.core.ram.write import write_bytes as _async_write_bytes
from mirage.io.types import IOResult


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
        byte_offsets=kwargs.get("byte_offsets", False),
        io=kwargs.get("io"),
    )


class TestRgMatchesFilter:

    def test_hidden_excluded(self):
        assert not _rg_matches_filter(".hidden", None, None, False)

    def test_hidden_included(self):
        assert _rg_matches_filter(".hidden", None, None, True)

    def test_file_type_match(self):
        assert _rg_matches_filter("file.py", "py", None, False)

    def test_file_type_no_match(self):
        assert not _rg_matches_filter("file.txt", "py", None, False)

    def test_glob_match(self):
        assert _rg_matches_filter("file.py", None, "*.py", False)

    def test_glob_no_match(self):
        assert not _rg_matches_filter("file.txt", None, "*.py", False)


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


class TestOnlyMatchingDirectoryWalk:
    """GNU's -o rule holds on the directory branch, not just single files.

    Every non-empty match prints on its own line and an empty match
    prints nothing at all, while the line still counts as selected. The
    directory branch words only the per-file label differently (-I drops
    it), so it had drifted to printing just the first match and, for an
    empty match, a label with nothing after it.
    """

    @pytest.mark.anyio
    async def test_every_match_on_the_line(self, backend):
        await _mkdir(backend, "/tmp/d")
        await _write(backend, "/tmp/d/x.txt", "a1b2c\n")
        result = await rg(backend,
                          "/tmp/d",
                          "[0-9]",
                          only_matching=True,
                          line_numbers=False)
        assert result == ["/tmp/d/x.txt:1", "/tmp/d/x.txt:2"]

    @pytest.mark.anyio
    async def test_line_numbers_repeat_per_match(self, backend):
        await _mkdir(backend, "/tmp/d")
        await _write(backend, "/tmp/d/x.txt", "a1b2c\n")
        result = await rg(backend,
                          "/tmp/d",
                          "[0-9]",
                          only_matching=True,
                          line_numbers=True)
        assert result == ["/tmp/d/x.txt:1:1", "/tmp/d/x.txt:1:2"]

    @pytest.mark.anyio
    async def test_empty_match_prints_no_bare_label(self, backend):
        await _mkdir(backend, "/tmp/d")
        await _write(backend, "/tmp/d/y.txt", "ab\n")
        result = await rg(backend,
                          "/tmp/d",
                          "[0-9]*",
                          only_matching=True,
                          line_numbers=False)
        assert result == []

    @pytest.mark.anyio
    async def test_empty_matches_dropped_around_a_real_one(self, backend):
        await _mkdir(backend, "/tmp/d")
        await _write(backend, "/tmp/d/z.txt", "1a22b\n")
        result = await rg(backend,
                          "/tmp/d",
                          "[0-9]*",
                          only_matching=True,
                          line_numbers=False)
        assert result == ["/tmp/d/z.txt:1", "/tmp/d/z.txt:22"]

    @pytest.mark.anyio
    async def test_count_still_counts_the_selected_line(self, backend):
        await _mkdir(backend, "/tmp/d")
        await _write(backend, "/tmp/d/y.txt", "ab\n")
        result = await rg(backend,
                          "/tmp/d",
                          "[0-9]*",
                          only_matching=True,
                          count_only=True)
        assert result == ["/tmp/d/y.txt:1"]


class TestRgByteOffsets:
    """rg -b agrees with GNU grep on offsets and on field order."""

    @pytest.mark.anyio
    async def test_single_file_prints_the_line_start_offset(self, backend):
        await _write(backend, "/tmp/f1", "abc\ndefabc\nabc abc\n")
        result = await rg(backend,
                          "/tmp/f1",
                          "abc",
                          line_numbers=False,
                          byte_offsets=True)
        assert result == ["0:abc", "4:defabc", "11:abc abc"]

    @pytest.mark.anyio
    async def test_single_file_prints_the_match_offset_under_o(self, backend):
        await _write(backend, "/tmp/f1", "abc\ndefabc\nabc abc\n")
        result = await rg(backend,
                          "/tmp/f1",
                          "abc",
                          line_numbers=False,
                          only_matching=True,
                          byte_offsets=True)
        assert result == ["0:abc", "7:abc", "11:abc", "15:abc"]

    @pytest.mark.anyio
    async def test_field_order_is_line_then_byte(self, backend):
        await _write(backend, "/tmp/f1", "abc\ndefabc\n")
        result = await rg(backend,
                          "/tmp/f1",
                          "abc",
                          line_numbers=True,
                          byte_offsets=True)
        assert result == ["1:0:abc", "2:4:defabc"]

    @pytest.mark.anyio
    async def test_offsets_count_bytes_not_characters(self, backend):
        await _write(backend, "/tmp/f5", "café abc\nxéy abc\n")
        result = await rg(backend,
                          "/tmp/f5",
                          "abc",
                          line_numbers=False,
                          only_matching=True,
                          byte_offsets=True)
        assert result == ["6:abc", "15:abc"]

    @pytest.mark.anyio
    async def test_walk_keeps_the_filename_ahead_of_the_fields(self, backend):
        await _mkdir(backend, "/tmp/d")
        await _write(backend, "/tmp/d/x.txt", "abc\ndefabc\n")
        result = await rg(backend,
                          "/tmp/d",
                          "abc",
                          line_numbers=True,
                          byte_offsets=True)
        assert result == ["/tmp/d/x.txt:1:0:abc", "/tmp/d/x.txt:2:4:defabc"]

    @pytest.mark.anyio
    async def test_a_count_carries_no_offset(self, backend):
        await _mkdir(backend, "/tmp/d")
        await _write(backend, "/tmp/d/x.txt", "abc\ndefabc\n")
        result = await rg(backend,
                          "/tmp/d",
                          "abc",
                          count_only=True,
                          byte_offsets=True)
        assert result == ["/tmp/d/x.txt:2"]


class TestRgFullReportsSelection:
    """Selection cannot be read off the printed lines under -o.

    A directory whose only matches are zero-width prints nothing and GNU
    still exits 0; ``rg_full`` returns only the printed lines, so the
    status rides the same ``io`` channel ``grep_lines`` and
    ``grep_stream`` already take.
    """

    @pytest.mark.anyio
    async def test_directory_of_empty_matches_reports_selection(self, backend):
        await _mkdir(backend, "/tmp/d")
        await _write(backend, "/tmp/d/y.txt", "ab\n")
        io = IOResult(exit_code=1)
        result = await rg(backend,
                          "/tmp/d",
                          "[0-9]*",
                          only_matching=True,
                          line_numbers=False,
                          io=io)
        assert (result, io.exit_code) == ([], 0)

    @pytest.mark.anyio
    async def test_directory_with_no_match_leaves_the_status_alone(
            self, backend):
        await _mkdir(backend, "/tmp/d")
        await _write(backend, "/tmp/d/y.txt", "ab\n")
        io = IOResult(exit_code=1)
        result = await rg(backend,
                          "/tmp/d",
                          "[0-9]",
                          only_matching=True,
                          line_numbers=False,
                          io=io)
        assert (result, io.exit_code) == ([], 1)

    @pytest.mark.anyio
    async def test_single_file_of_empty_matches_reports_selection(
            self, backend):
        await _write(backend, "/tmp/y.txt", "ab\n")
        io = IOResult(exit_code=1)
        result = await rg(backend,
                          "/tmp/y.txt",
                          "[0-9]*",
                          only_matching=True,
                          line_numbers=False,
                          io=io)
        assert (result, io.exit_code) == ([], 0)


async def _write_bytes(backend, path, content):
    accessor = backend.accessor
    await _async_write_bytes(accessor, to_pathspec(path), content)


class TestRgSplitsOnNewlinesOnly:
    """A line ends at `\\n`, and nothing else ends one.

    `str.splitlines` also breaks on `\\r`, `\\v`, `\\f`, `\\x1c`-`\\x1e`,
    `\\x85`, U+2028 and U+2029, so a CRLF file read as two lines with the
    carriage returns eaten where GNU (and ripgrep 14.1.0) keep them:
    `rg -n -v zzz` over `a\\r\\nb\\r\\n` is `1:a\\r` and `2:b\\r`, and
    `rg -b b` is `3:b\\r`.
    """

    @pytest.mark.anyio
    async def test_carriage_return_stays_in_the_line(self, backend):
        await _write_bytes(backend, "/tmp/crlf.txt", b"a\r\nb\r\n")
        result = await rg(backend, "/tmp/crlf.txt", "zzz", invert=True)
        assert result == ["1:a\r", "2:b\r"]

    @pytest.mark.anyio
    async def test_carriage_return_counts_toward_the_byte_offset(
            self, backend):
        await _write_bytes(backend, "/tmp/crlf.txt", b"a\r\nb\r\n")
        result = await rg(backend,
                          "/tmp/crlf.txt",
                          "b",
                          line_numbers=False,
                          byte_offsets=True)
        assert result == ["3:b\r"]

    @pytest.mark.anyio
    async def test_the_terminator_does_not_open_a_last_empty_line(
            self, backend):
        await _write_bytes(backend, "/tmp/ab.txt", b"a\nb\n")
        result = await rg(backend,
                          "/tmp/ab.txt",
                          "zzz",
                          invert=True,
                          count_only=True,
                          line_numbers=False)
        assert result == ["2"]

    @pytest.mark.anyio
    async def test_a_vertical_tab_does_not_end_a_line(self, backend):
        await _write_bytes(backend, "/tmp/vt.txt", b"a\vb\n")
        result = await rg(backend, "/tmp/vt.txt", "zzz", invert=True)
        assert result == ["1:a\vb"]


class TestRgMaxCountZeroSelectsNothing:
    """`-m 0` selects no line, which is what GNU and ripgrep both do.

    Measured: `rg -m0 a f`, `rg -m0 -c a f` and `rg -m0 -l a f` on ripgrep
    14.1.0 and the same three on GNU grep 3.11 all print zero bytes and
    exit 1.
    """

    @pytest.mark.anyio
    async def test_single_file_prints_nothing(self, backend):
        await _write(backend, "/tmp/m.txt", "a\nab\nb\n")
        io = IOResult(exit_code=1)
        result = await rg(backend, "/tmp/m.txt", "a", max_count=0, io=io)
        assert (result, io.exit_code) == ([], 1)

    @pytest.mark.anyio
    async def test_single_file_counts_nothing(self, backend):
        await _write(backend, "/tmp/m.txt", "a\nab\nb\n")
        result = await rg(backend,
                          "/tmp/m.txt",
                          "a",
                          max_count=0,
                          count_only=True)
        assert result == []

    @pytest.mark.anyio
    async def test_single_file_names_nothing(self, backend):
        await _write(backend, "/tmp/m.txt", "a\nab\nb\n")
        result = await rg(backend,
                          "/tmp/m.txt",
                          "a",
                          max_count=0,
                          files_only=True)
        assert result == []

    @pytest.mark.anyio
    async def test_a_walk_prints_nothing(self, backend):
        await _mkdir(backend, "/tmp/m0")
        await _write(backend, "/tmp/m0/x.txt", "a\nab\n")
        result = await rg(backend, "/tmp/m0", "a", max_count=0)
        assert result == []


class TestRgOnlyMatchingWithInvertPrintsNothing:
    """`-o -v` prints nothing: an unselected pattern has no match to print.

    GNU grep 3.11 over `abc\\ndef\\n` answers zero bytes and exit 0 for
    `grep -ov abc`, and `1` for `grep -ovc`. ripgrep prints the whole line,
    and GNU is the reference this family already follows for -o.
    """

    @pytest.mark.anyio
    async def test_single_file_prints_nothing(self, backend):
        await _write(backend, "/tmp/ov.txt", "abc\ndef\n")
        io = IOResult(exit_code=1)
        result = await rg(backend,
                          "/tmp/ov.txt",
                          "abc",
                          only_matching=True,
                          invert=True,
                          io=io)
        assert (result, io.exit_code) == ([], 0)

    @pytest.mark.anyio
    async def test_single_file_still_counts_the_selected_line(self, backend):
        await _write(backend, "/tmp/ov.txt", "abc\ndef\n")
        result = await rg(backend,
                          "/tmp/ov.txt",
                          "abc",
                          only_matching=True,
                          invert=True,
                          count_only=True)
        assert result == ["1"]

    @pytest.mark.anyio
    async def test_a_walk_prints_nothing(self, backend):
        await _mkdir(backend, "/tmp/ovd")
        await _write(backend, "/tmp/ovd/x.txt", "abc\ndef\n")
        result = await rg(backend,
                          "/tmp/ovd",
                          "abc",
                          only_matching=True,
                          invert=True)
        assert result == []


class TestRgOffsetsOverSmuggledBytes:
    """A byte offset counts bytes, and an invalid byte is one byte.

    `rg -b a` over `\\xff\\na\\n` is `2:a` on ripgrep 14.1.0 and GNU grep
    3.11; `rg -bo a` over `\\xffa\\n` is `1:a`. A replacing decode read the
    invalid byte as U+FFFD, three bytes wide, so both answers ran ahead.
    """

    @pytest.mark.anyio
    async def test_line_offset_counts_one_byte(self, backend):
        await _write_bytes(backend, "/tmp/inv.bin", b"\xff\na\n")
        result = await rg(backend,
                          "/tmp/inv.bin",
                          "a",
                          line_numbers=False,
                          byte_offsets=True)
        assert result == ["2:a"]

    @pytest.mark.anyio
    async def test_match_offset_counts_one_byte(self, backend):
        await _write_bytes(backend, "/tmp/inv2.bin", b"\xffa\n")
        result = await rg(backend,
                          "/tmp/inv2.bin",
                          "a",
                          line_numbers=False,
                          only_matching=True,
                          byte_offsets=True)
        assert result == ["1:a"]

    @pytest.mark.anyio
    async def test_a_multibyte_character_counts_its_bytes(self, backend):
        # section Q6 of the GNU truth file: the match on line one is at byte
        # 6, not at the character index 5, and line two's is at 15.
        await _write(backend, "/tmp/f5.txt", "café abc\nxéy abc\n")
        result = await rg(backend,
                          "/tmp/f5.txt",
                          "abc",
                          line_numbers=False,
                          only_matching=True,
                          byte_offsets=True)
        assert result == ["6:abc", "15:abc"]

    @pytest.mark.anyio
    async def test_a_printed_line_replaces_a_smuggled_byte(self, backend):
        # The scan answers in `list[str]`, which `format_records` encodes
        # strictly, so the byte prints as U+FFFD -- what a replacing decode
        # already gave, with the offset now right.
        await _write_bytes(backend, "/tmp/inv3.bin", b"\xffa\n")
        result = await rg(backend,
                          "/tmp/inv3.bin",
                          "a",
                          line_numbers=False,
                          byte_offsets=True)
        assert result == ["0:�a"]


class TestRgFilesOnlyNamesTheFile:
    """`-l` answers with the path even when no label was asked for.

    The path IS the output under -l, so it is never dropped for want of a
    `-H`: `rg -l a f` prints `f` on ripgrep 14.1.0, and the TypeScript twin
    used to print an empty line for a single unlabelled operand.
    """

    @pytest.mark.anyio
    async def test_single_unlabelled_operand(self, backend):
        await _write(backend, "/tmp/m.txt", "a\nab\n")
        result = await rg(backend, "/tmp/m.txt", "a", files_only=True)
        assert result == ["/tmp/m.txt"]


class TestRgMaxCountIsPerFileInAWalk:
    """`-m N` counts per file, not per walk, as ripgrep's does.

    `rg -m1 a dir` prints one line per file on ripgrep 14.1.0. The walk's
    printing path had the limit only inside its count arm, so it printed
    every match where `searchFile` in rg_scan.ts stopped at the first.
    """

    @pytest.mark.anyio
    async def test_one_line_per_file(self, backend):
        await _mkdir(backend, "/tmp/mw")
        await _write(backend, "/tmp/mw/x.txt", "a1\na2\na3\n")
        result = await rg(backend, "/tmp/mw", "a", max_count=1)
        assert result == ["/tmp/mw/x.txt:1:a1"]

    @pytest.mark.anyio
    async def test_two_lines_per_file(self, backend):
        await _mkdir(backend, "/tmp/mw2")
        await _write(backend, "/tmp/mw2/x.txt", "a1\na2\na3\n")
        result = await rg(backend, "/tmp/mw2", "a", max_count=2)
        assert result == ["/tmp/mw2/x.txt:1:a1", "/tmp/mw2/x.txt:2:a2"]

    @pytest.mark.anyio
    async def test_the_limit_restarts_for_each_file(self, backend):
        await _mkdir(backend, "/tmp/mw3")
        await _write(backend, "/tmp/mw3/x.txt", "a1\na2\n")
        await _write(backend, "/tmp/mw3/y.txt", "a3\na4\n")
        result = await rg(backend, "/tmp/mw3", "a", max_count=1)
        assert result == ["/tmp/mw3/x.txt:1:a1", "/tmp/mw3/y.txt:1:a3"]
