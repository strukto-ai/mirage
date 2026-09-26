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

from mirage.commands.builtin.generic.rg import parse_flags
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic.rg import walk_filter
from mirage.commands.builtin.rg_scan import WalkFilter, walk_candidates
from mirage.commands.builtin.utils.wrap import to_pathspec
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.ram.mkdir import mkdir
from mirage.core.ram.read import read
from mirage.core.ram.readdir import readdir
from mirage.core.ram.stat import stat
from mirage.core.ram.write import write_bytes as _async_write_bytes
from mirage.io.stream import materialize
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, PathSpec


async def _write(backend, path, content):
    accessor = backend.accessor
    await _async_write_bytes(accessor, to_pathspec(path), content.encode())


async def _mkdir(backend, path):
    accessor = backend.accessor
    await mkdir(accessor, to_pathspec(path), parents=True)


# The keywords the scan used to take, as the rg dests they stand for.
_DESTS = {
    "ignore_case": "ignore_case",
    "invert": "invert_match",
    "count_only": "count",
    "files_only": "files_with_matches",
    "fixed_string": "fixed_strings",
    "only_matching": "only_matching",
    "max_count": "max_count",
    "whole_word": "word_regexp",
    "context_before": "before_context",
    "context_after": "after_context",
    "hidden": "hidden",
    "byte_offsets": "byte_offset",
    "files_without_match": "files_without_match",
}


async def rg(backend, path, pattern, **kwargs):
    """Run the generic rg over one operand on the RAM backend and answer
    with its printed lines, the way the scan these tests were written for
    answered.

    A line number prints unless ``line_numbers=False``; ``warnings``
    receives stderr's lines and ``io`` the exit status.
    """
    flags: dict = {}
    if kwargs.get("line_numbers", True):
        flags["line_number"] = True
    # In the order the call gave them, which is line order to a
    # last-wins option.
    for key, value in kwargs.items():
        dest = _DESTS.get(key)
        if dest is None or value is None or value is False:
            continue
        flags[dest] = str(value) if isinstance(
            value, int) and not isinstance(value, bool) else value
    if kwargs.get("file_type") is not None:
        flags["type"] = [kwargs["file_type"]]
    if kwargs.get("glob_pattern") is not None:
        flags["glob"] = [kwargs["glob_pattern"]]
    accessor = backend.accessor
    out, io = await generic_rg([to_pathspec(path)], [pattern],
                               CommandOpts(flags=flags),
                               readdir=partial(readdir, accessor),
                               stat=partial(stat, accessor),
                               read_bytes=partial(read, accessor),
                               read_stream=None)
    data = await materialize(out) if out is not None else b""
    if kwargs.get("warnings") is not None and io.stderr:
        stderr = await materialize(io.stderr)
        kwargs["warnings"].extend(stderr.decode().splitlines())
    if kwargs.get("io") is not None:
        kwargs["io"].exit_code = io.exit_code
    text = data.decode(errors="surrogateescape")
    # Split on the terminator alone, as rg does: a \r or \v stays.
    return text.split("\n")[:-1] if text else []


def _walk(**flags) -> WalkFilter:
    return walk_filter(parse_flags(FlagView(flags, spec=SPECS["rg"])))


class TestWalkFilter:

    def test_hidden_excluded(self):
        assert not _walk().admits_file(".hidden", ".hidden", None)

    def test_hidden_included(self):
        assert _walk(hidden=True).admits_file(".hidden", ".hidden", None)

    def test_file_type_match(self):
        assert _walk(type=["py"]).admits_file("file.py", "file.py", None)

    def test_file_type_no_match(self):
        assert not _walk(type=["py"]).admits_file("file.txt", "file.txt", None)

    def test_glob_match(self):
        assert _walk(glob=["*.py"]).admits_file("file.py", "file.py", None)

    def test_glob_no_match(self):
        assert not _walk(glob=["*.py"]).admits_file("file.txt", "file.txt",
                                                    None)

    def test_a_type_or_glob_keeps_a_hidden_file(self):
        # ripgrep 14.1.1: `rg -t txt` and `rg -g '*.txt'` search
        # .hid.txt, since a whitelist decides before the hidden filter.
        assert _walk(type=["txt"]).admits_file(".hid.txt", ".hid.txt", None)
        assert _walk(glob=["*.txt"]).admits_file(".hid.txt", ".hid.txt", None)

    def test_a_negated_glob_outranks_a_type(self):
        walk = _walk(type=["py"], glob=["!b.py"])
        assert not walk.admits_file("b.py", "b.py", None)
        assert walk.admits_file("a.py", "a.py", None)

    def test_max_filesize_drops_a_larger_file(self):
        walk = _walk(max_filesize="10")
        small = FileStat(name="a", size=10, type=FileType.FILE)
        big = FileStat(name="b", size=11, type=FileType.FILE)
        assert walk.admits_file("a", "a", small)
        assert not walk.admits_file("b", "b", big)

    def test_a_binary_extension_is_walked_only_on_request(self):
        assert not _walk().admits_file("m.gguf", "m.gguf", None)
        assert _walk(text=True).admits_file("m.gguf", "m.gguf", None)
        assert _walk(binary=True).admits_file("m.gguf", "m.gguf", None)
        assert _walk(unrestricted=3).admits_file("m.gguf", "m.gguf", None)
        assert not _walk(text=True, no_text=True).admits_file(
            "m.gguf", "m.gguf", None)


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
        # A named file is searched whatever --type says (ripgrep 14.1.1).
        await _write(backend, "/tmp/a.txt", "hello")
        result = await rg(backend, "/tmp/a.txt", "hello", file_type="py")
        assert result == ["1:hello"]


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
        # The path named the way the operand was typed.
        warnings = []
        result = await rg(backend,
                          "/tmp/nonexistent.txt",
                          "foo",
                          warnings=warnings)
        assert result == []
        assert warnings == [
            "rg: /tmp/nonexistent.txt: No such file or directory"
        ]

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
        assert warnings == ["rg: /tmp/nodir: No such file or directory"]


class TestOnlyMatchingDirectoryWalk:
    """ripgrep's -o rule holds on the directory branch, not just one file.

    Every match prints on its own line, an empty one included, found the
    way Rust's regex iterates (an empty match where the last one ended is
    skipped), and -c counts the matches (ripgrep 14.1.1). The directory
    branch words only the per-file label differently (-I drops it).
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
    async def test_empty_matches_print_under_the_label(self, backend):
        await _mkdir(backend, "/tmp/d")
        await _write(backend, "/tmp/d/y.txt", "ab\n")
        result = await rg(backend,
                          "/tmp/d",
                          "[0-9]*",
                          only_matching=True,
                          line_numbers=False)
        assert result == ["/tmp/d/y.txt:"] * 3

    @pytest.mark.anyio
    async def test_an_empty_match_right_after_a_match_is_skipped(
            self, backend):
        await _mkdir(backend, "/tmp/d")
        await _write(backend, "/tmp/d/z.txt", "1a22b\n")
        result = await rg(backend,
                          "/tmp/d",
                          "[0-9]*",
                          only_matching=True,
                          line_numbers=False)
        assert result == ["/tmp/d/z.txt:1", "/tmp/d/z.txt:22", "/tmp/d/z.txt:"]

    @pytest.mark.anyio
    async def test_count_counts_every_match(self, backend):
        await _mkdir(backend, "/tmp/d")
        await _write(backend, "/tmp/d/y.txt", "ab\n")
        result = await rg(backend,
                          "/tmp/d",
                          "[0-9]*",
                          only_matching=True,
                          count_only=True)
        assert result == ["/tmp/d/y.txt:3"]


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
    """The status rides ``io``, not the printed lines.

    ``rg_full`` returns only the printed lines, so the status rides the
    same ``io`` channel ``grep_lines`` and ``grep_stream`` already take;
    a zero-width match selects its line and prints an empty piece.
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
        assert (result, io.exit_code) == (["/tmp/d/y.txt:"] * 3, 0)

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
        assert (result, io.exit_code) == ([""] * 3, 0)


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


class TestRgOnlyMatchingWithInvertPrintsLinesWhole:
    """`rg -o -v` prints each selected line whole: it holds no match.

    ripgrep 14.1.1 over `abc\\ndef\\n` answers `def` for `rg -ov abc` and
    `0` for `rg -ovc abc`, counting matches, where GNU grep prints nothing
    and counts the line. rg follows ripgrep.
    """

    @pytest.mark.anyio
    async def test_single_file_prints_the_line_whole(self, backend):
        await _write(backend, "/tmp/ov.txt", "abc\ndef\n")
        io = IOResult(exit_code=1)
        result = await rg(backend,
                          "/tmp/ov.txt",
                          "abc",
                          only_matching=True,
                          invert=True,
                          io=io)
        assert (result, io.exit_code) == (["2:def"], 0)

    @pytest.mark.anyio
    async def test_single_file_counts_no_matches(self, backend):
        await _write(backend, "/tmp/ov.txt", "abc\ndef\n")
        result = await rg(backend,
                          "/tmp/ov.txt",
                          "abc",
                          only_matching=True,
                          invert=True,
                          count_only=True)
        assert result == ["0"]

    @pytest.mark.anyio
    async def test_a_walk_prints_the_line_whole(self, backend):
        await _mkdir(backend, "/tmp/ovd")
        await _write(backend, "/tmp/ovd/x.txt", "abc\ndef\n")
        result = await rg(backend,
                          "/tmp/ovd",
                          "abc",
                          only_matching=True,
                          invert=True)
        assert result == ["/tmp/ovd/x.txt:2:def"]


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
        # The scan answers in `list[str]`, and the byte rides through as
        # the surrogate escape `decode_line` gave it: `format_records`
        # puts it back as itself, which is what ripgrep prints (measured
        # 14.1.1: `\377` reaches the terminal raw, never as U+FFFD).
        await _write_bytes(backend, "/tmp/inv3.bin", b"\xffa\n")
        result = await rg(backend,
                          "/tmp/inv3.bin",
                          "a",
                          line_numbers=False,
                          byte_offsets=True)
        assert result == ["0:\udcffa"]


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


class TestFilesWithoutMatch:
    """ripgrep's --files-without-match: the paths that selected no line.

    -c outranks it (ripgrep 14.1.1 prints counts), and -m0 lists nothing
    since it is read before the scan. Mirrored in rg_scan.test.ts.
    """

    @pytest.mark.anyio
    async def test_lists_the_matchless_file(self, backend):
        await _write(backend, "/tmp/a.txt", "bar\nbaz")
        assert await rg(backend, "/tmp/a.txt", "foo",
                        files_without_match=True) == ["/tmp/a.txt"]

    @pytest.mark.anyio
    async def test_a_matching_file_is_not_listed(self, backend):
        await _write(backend, "/tmp/a.txt", "foo\nbar")
        assert await rg(backend, "/tmp/a.txt", "foo",
                        files_without_match=True) == []

    @pytest.mark.anyio
    async def test_walk_lists_only_the_matchless_files(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/a.txt", "hello")
        await _write(backend, "/tmp/sub/b.txt", "world")
        result = await rg(backend, "/tmp", "hello", files_without_match=True)
        assert result == ["/tmp/sub/b.txt"]

    @pytest.mark.anyio
    async def test_the_later_of_it_and_count_wins(self, backend):
        # ripgrep 14.1.1: `--files-without-match -c` prints counts and
        # `-c --files-without-match` lists the matchless files.
        await _write(backend, "/tmp/a.txt", "foo\nfoo")
        assert await rg(backend,
                        "/tmp/a.txt",
                        "foo",
                        files_without_match=True,
                        count_only=True) == ["2"]
        assert await rg(backend,
                        "/tmp/a.txt",
                        "foo",
                        count_only=True,
                        files_without_match=True) == []

    @pytest.mark.anyio
    async def test_m0_lists_nothing(self, backend):
        await _write(backend, "/tmp/a.txt", "bar")
        assert await rg(backend,
                        "/tmp/a.txt",
                        "foo",
                        max_count=0,
                        files_without_match=True) == []


class TestWalkContext:
    """A walk prints context the way ripgrep 14.1.1 does.

    Every line leads with its file's name, `name:` on a match and
    `name-` on context, and `--` sits between one file's context and the
    next file's.
    """

    @pytest.mark.anyio
    async def test_labels_every_line_and_separates_files(self, backend):
        await _mkdir(backend, "/tmp/w")
        await _write(backend, "/tmp/w/a.txt", "x\nhit\ny\n")
        await _write(backend, "/tmp/w/b.txt", "hit\nz\n")
        assert await rg(backend, "/tmp/w", "hit", context_after=1) == [
            "/tmp/w/a.txt:2:hit", "/tmp/w/a.txt-3-y", "--",
            "/tmp/w/b.txt:1:hit", "/tmp/w/b.txt-2-z"
        ]

    @pytest.mark.anyio
    async def test_a_file_with_nothing_printed_adds_no_separator(
            self, backend):
        await _mkdir(backend, "/tmp/w")
        await _write(backend, "/tmp/w/a.txt", "hit\n")
        await _write(backend, "/tmp/w/b.txt", "miss\n")
        await _write(backend, "/tmp/w/c.txt", "hit\n")
        assert await rg(backend, "/tmp/w", "hit", context_after=1) == [
            "/tmp/w/a.txt:1:hit", "--", "/tmp/w/c.txt:1:hit"
        ]

    @pytest.mark.anyio
    async def test_counts_take_no_separator(self, backend):
        await _mkdir(backend, "/tmp/w")
        await _write(backend, "/tmp/w/a.txt", "hit\n")
        await _write(backend, "/tmp/w/b.txt", "hit\n")
        assert await rg(backend,
                        "/tmp/w",
                        "hit",
                        context_after=1,
                        count_only=True) == [
                            "/tmp/w/a.txt:1", "/tmp/w/b.txt:1"
                        ]


def _scope(virtual: str = "/data") -> PathSpec:
    return PathSpec(vfs_path="", virtual=virtual, directory=virtual)


def _candidate(virtual: str) -> PathSpec:
    return PathSpec(vfs_path=virtual.removeprefix("/data/"),
                    virtual=virtual,
                    directory="",
                    resolved=True)


class TestWalkCandidates:
    """Narrowed candidates pass the filters the walk they replace applies."""

    def test_drops_dotfiles_below_the_scope(self):
        kept = walk_candidates([
            _candidate("/data/.env"),
            _candidate("/data/.git/config"),
            _candidate("/data/a.txt")
        ], [_scope()], _walk(), "/")
        assert [p.virtual for p in kept] == ["/data/a.txt"]

    def test_hidden_flag_keeps_dotfiles(self):
        paths = [_candidate("/data/.env"), _candidate("/data/a.txt")]
        assert walk_candidates(paths, [_scope()], _walk(hidden=True),
                               "/") == paths

    def test_ignores_dots_in_the_scope_itself(self):
        kept = walk_candidates([_candidate("/data/.cfg/a.txt")],
                               [_scope("/data/.cfg")], _walk(), "/")
        assert [p.virtual for p in kept] == ["/data/.cfg/a.txt"]

    def test_applies_type_and_glob_to_the_file(self):
        paths = [_candidate("/data/a.py"), _candidate("/data/b.md")]
        by_type = walk_candidates(paths, [_scope()], _walk(type=["py"]), "/")
        by_glob = walk_candidates(paths, [_scope()], _walk(glob=["*.md"]), "/")
        assert [p.virtual for p in by_type] == ["/data/a.py"]
        assert [p.virtual for p in by_glob] == ["/data/b.md"]

    def test_a_directory_the_walk_would_skip_hides_its_files(self):
        paths = [_candidate("/data/sub/a.py"), _candidate("/data/b.py")]
        kept = walk_candidates(paths, [_scope()], _walk(glob=["!sub/"]), "/")
        assert [p.virtual for p in kept] == ["/data/b.py"]

    def test_max_depth_counts_below_the_scope(self):
        paths = [_candidate("/data/a.py"), _candidate("/data/sub/b.py")]
        kept = walk_candidates(paths, [_scope()], _walk(max_depth="1"), "/")
        assert [p.virtual for p in kept] == ["/data/a.py"]


class TestNamedOperandsAreNeverFiltered:
    """ripgrep 14.1.1 searches a file named on the line whatever --type,
    --glob or a leading dot say (`rg --type rust b in` prints `b`)."""

    @pytest.mark.anyio
    @pytest.mark.parametrize("kwargs", [{"glob_pattern": "*.rs"}, {}])
    async def test_a_named_file_is_searched(self, backend, kwargs):
        await _write(backend, "/tmp/.in", "b\n")
        assert await rg(backend, "/tmp/.in", "b", **kwargs) == ["1:b"]

    @pytest.mark.anyio
    async def test_a_walked_file_is_still_filtered(self, backend):
        # The type keeps .hid.rs whatever its leading dot says (ripgrep
        # 14.1.1's `rg -t txt` searches .hid.txt), and drops `in`.
        await _mkdir(backend, "/tmp/w")
        await _write(backend, "/tmp/w/in", "b\n")
        await _write(backend, "/tmp/w/.hid.rs", "b\n")
        assert await rg(backend, "/tmp/w", "b",
                        file_type="rust") == ["/tmp/w/.hid.rs:1:b"]


def test_walk_candidates_prunes_below_the_longest_matching_scope():
    scopes = [_scope(), _scope("/data/.cfg")]
    kept = walk_candidates(
        [_candidate("/data/.cfg/a.txt"),
         _candidate("/data/.cfg/.secret")], scopes, _walk(), "/")
    assert [p.virtual for p in kept] == ["/data/.cfg/a.txt"]
