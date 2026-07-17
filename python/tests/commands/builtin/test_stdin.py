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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace


def _ws() -> Workspace:
    mem = RAMResource()
    asyncio.run(
        mem.write(PathSpec.from_str_path("/hello.txt"),
                  data=b"hello\nworld\nfoo\n"))
    return Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )


def _run_raw(ws, cmd, cwd="/", stdin=None):
    ws._cwd = cwd
    io = asyncio.run(ws.execute(cmd, stdin=stdin))
    return io.stdout, io


async def _drain_async(stream):
    return b"".join([chunk async for chunk in stream])


def _collect(stdout):
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    if hasattr(stdout, "__aiter__"):
        return asyncio.run(_drain_async(stdout))
    return b"".join(stdout)


def _str(stdout):
    return _collect(stdout).decode(errors="replace")


def _bytes(stdout):
    return _collect(stdout)


def test_cat_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws, "cat", stdin=b"from stdin\n")
    assert b"from stdin" in _bytes(stdout)


def test_cat_stdin_empty_raises():
    ws = _ws()
    stdout, io = _run_raw(ws, "cat", stdin=None)
    assert io.exit_code == 1


def test_head_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws, "head -n 1", stdin=b"line1\nline2\nline3\n")
    assert _str(stdout).strip() == "line1"


def test_head_stdin_bytes_mode():
    ws = _ws()
    stdout, _ = _run_raw(ws, "head -c 5", stdin=b"hello world")
    assert _str(stdout) == "hello"


def test_tail_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws, "tail -n 1", stdin=b"line1\nline2\nline3\n")
    assert _str(stdout).strip() == "line3"


def test_tail_stdin_bytes_mode():
    ws = _ws()
    stdout, _ = _run_raw(ws, "tail -c 5", stdin=b"hello world")
    assert _str(stdout) == "world"


def test_wc_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws, "wc -l", stdin=b"a\nb\nc\n")
    assert "3" in _str(stdout)


def test_wc_stdin_full():
    ws = _ws()
    stdout, _ = _run_raw(ws, "wc", stdin=b"one two\nthree\n")
    out = _str(stdout)
    assert "2" in out
    assert "3" in out


def test_sort_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sort", stdin=b"c\na\nb\n")
    assert _str(stdout).strip() == "a\nb\nc"


def test_sort_stdin_reverse():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sort -r", stdin=b"a\nb\nc\n")
    assert _str(stdout).strip() == "c\nb\na"


def test_sort_stdin_numeric():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sort -n", stdin=b"10\n2\n1\n20\n")
    assert _str(stdout).strip() == "1\n2\n10\n20"


def test_sort_stdin_unique():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sort -u", stdin=b"a\nb\na\n")
    assert _str(stdout).strip().count("a") == 1


def test_uniq_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws, "uniq", stdin=b"a\na\nb\n")
    assert _str(stdout).strip() == "a\nb"


def test_uniq_stdin_count():
    ws = _ws()
    stdout, _ = _run_raw(ws, "uniq -c", stdin=b"a\na\nb\n")
    out = _str(stdout)
    assert "2" in out
    assert "1" in out


def test_grep_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws,
                         "grep hello",
                         stdin=b"hello world\nfoo bar\nhello again\n")
    lines = _str(stdout).strip().splitlines()
    assert len(lines) == 2


def test_grep_stdin_ignore_case():
    ws = _ws()
    stdout, _ = _run_raw(ws,
                         "grep -i HELLO",
                         stdin=b"Hello world\nfoo\nhello again\n")
    lines = _str(stdout).strip().splitlines()
    assert len(lines) == 2


def test_grep_stdin_count():
    ws = _ws()
    stdout, _ = _run_raw(ws, "grep -c foo", stdin=b"foo\nbar\nfoo\n")
    assert _str(stdout).strip() == "2"


def test_grep_stdin_line_numbers():
    ws = _ws()
    stdout, _ = _run_raw(ws, "grep -n foo", stdin=b"foo\nbar\nfoo\n")
    out = _str(stdout)
    assert "1:foo" in out
    assert "3:foo" in out


def test_grep_stdin_invert():
    ws = _ws()
    stdout, _ = _run_raw(ws, "grep -v foo", stdin=b"foo\nbar\nbaz\n")
    out = _str(stdout).strip()
    assert "foo" not in out
    assert "bar" in out


def test_grep_stdin_fixed_string():
    ws = _ws()
    stdout, _ = _run_raw(ws, "grep -F a.b", stdin=b"a.b\naXb\n")
    out = _str(stdout).strip()
    assert "a.b" in out
    assert "aXb" not in out


def test_grep_stdin_only_matching():
    ws = _ws()
    stdout, _ = _run_raw(ws, "grep -o hello", stdin=b"hello world\n")
    assert _str(stdout).strip() == "hello"


def test_grep_stdin_max_count():
    ws = _ws()
    stdout, _ = _run_raw(ws, "grep -m 2 a", stdin=b"a\na\na\na\n")
    assert _str(stdout).strip().count("a") == 2


def test_rg_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws,
                         "rg hello",
                         stdin=b"hello world\nfoo bar\nhello again\n")
    lines = _str(stdout).strip().splitlines()
    assert len(lines) == 2


def test_cut_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws, "cut -f 1 -d ,", stdin=b"a,b,c\nd,e,f\n")
    assert _str(stdout).strip() == "a\nd"


def test_cut_stdin_chars():
    ws = _ws()
    stdout, _ = _run_raw(ws, "cut -c 1-5", stdin=b"hello world\n")
    assert _str(stdout).strip() == "hello"


def test_nl_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws, "nl", stdin=b"hello\nworld\n")
    out = _str(stdout)
    assert "1" in out
    assert "hello" in out


def test_sed_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed s/hello/bye/", stdin=b"hello world\n")
    assert "bye" in _str(stdout)


def test_sed_global_flag():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed s/o/0/g", stdin=b"foo boo\n")
    assert _str(stdout) == "f00 b00\n"


def test_sed_no_global_replaces_first_only():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed s/o/0/", stdin=b"foo boo\n")
    assert _str(stdout) == "f0o boo\n"


def test_sed_ignore_case_flag():
    ws = _ws()
    stdout, _ = _run_raw(ws,
                         "sed s/hello/bye/gi",
                         stdin=b"Hello HELLO hello\n")
    assert _str(stdout) == "bye bye bye\n"


def test_tee_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws, "tee /data/out.txt", stdin=b"piped content")
    assert "piped content" in _str(stdout)
    cat_stdout, _ = _run_raw(ws, "cat /data/out.txt")
    assert "piped content" in _str(cat_stdout)


def test_tr_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws, "tr h H", stdin=b"hello")
    assert _str(stdout) == "Hello"


def test_file_arg_takes_priority_over_stdin():
    ws = _ws()
    stdout, _ = _run_raw(ws, "cat /data/hello.txt", stdin=b"stdin content")
    assert b"hello" in _bytes(stdout)
    assert b"stdin content" not in _bytes(stdout)


def test_head_file_arg_takes_priority():
    ws = _ws()
    stdout, _ = _run_raw(ws,
                         "head -n 1 /data/hello.txt",
                         stdin=b"stdin line\n")
    assert "hello" in _str(stdout)
    assert "stdin" not in _str(stdout)


def test_grep_file_arg_takes_priority():
    ws = _ws()
    stdout, _ = _run_raw(ws,
                         "grep hello /data/hello.txt",
                         stdin=b"stdin content\n")
    assert "hello" in _str(stdout)
    assert "stdin" not in _str(stdout)


def test_sort_file_arg_takes_priority():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sort /data/hello.txt", stdin=b"zzz\n")
    assert "hello" in _str(stdout) or "foo" in _str(stdout)
    assert "zzz" not in _str(stdout)


def test_stdin_as_iterator():
    ws = _ws()
    stdout, _ = _run_raw(ws, "cat", stdin=b"chunk1\nchunk2\n")
    result = _str(stdout)
    assert "chunk1" in result
    assert "chunk2" in result


def test_echo_n_suppresses_newline():
    ws = _ws()
    stdout, _ = _run_raw(ws, "echo -n hello")
    assert _bytes(stdout) == b"hello"


def test_echo_default_adds_newline():
    ws = _ws()
    stdout, _ = _run_raw(ws, "echo hello")
    assert _bytes(stdout) == b"hello\n"


def test_cat_n_numbers_lines():
    ws = _ws()
    stdout, _ = _run_raw(ws, "cat -n", stdin=b"hello\nworld\n")
    out = _str(stdout)
    assert "1\thello" in out
    assert "2\tworld" in out


def test_tr_delete():
    ws = _ws()
    stdout, _ = _run_raw(ws, "tr -d aeiou", stdin=b"hello world")
    assert _str(stdout) == "hll wrld"


def test_tr_squeeze():
    ws = _ws()
    stdout, _ = _run_raw(ws, "tr -s a", stdin=b"baanaanaa")
    assert _str(stdout) == "banana"


def test_tr_range():
    ws = _ws()
    stdout, _ = _run_raw(ws, "tr a-z A-Z", stdin=b"hello")
    assert _str(stdout) == "HELLO"


def test_wc_m_counts_chars():
    ws = _ws()
    stdout, _ = _run_raw(ws, "wc -m", stdin=b"hello")
    assert _str(stdout).strip() == "5"


def test_wc_m_multibyte():
    ws = _ws()
    text = "café"
    raw = text.encode("utf-8")
    stdout, _ = _run_raw(ws, "wc -m", stdin=raw)
    assert _str(stdout).strip() == "4"


def test_wc_c_counts_bytes():
    ws = _ws()
    text = "café"
    raw = text.encode("utf-8")
    stdout, _ = _run_raw(ws, "wc -c", stdin=raw)
    assert _str(stdout).strip() == "5"


def test_cut_field_range():
    ws = _ws()
    stdout, _ = _run_raw(ws, "cut -f 1-3 -d ,", stdin=b"a,b,c,d,e\n")
    assert _str(stdout).strip() == "a,b,c"


def test_cut_field_range_and_single():
    ws = _ws()
    stdout, _ = _run_raw(ws, "cut -f 1-2,4 -d ,", stdin=b"a,b,c,d,e\n")
    assert _str(stdout).strip() == "a,b,d"


def test_nl_body_numbering_regex():
    ws = _ws()
    stdout, _ = _run_raw(ws,
                         "nl -b pfoo",
                         stdin=b"foo line\nbar line\nfoo again\n")
    out = _str(stdout)
    lines = out.strip().splitlines()
    assert "1" in lines[0] and "foo line" in lines[0]
    assert "bar line" in lines[1]
    assert "1" not in lines[1].split("\t")[0].strip() or lines[1].split(
        "\t")[0].strip() == ""
    assert "2" in lines[2] and "foo again" in lines[2]


def test_sed_delete_by_line():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed 2d", stdin=b"a\nb\nc\n")
    assert _str(stdout) == "a\nc\n"


def test_sed_delete_by_regex():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed /foo/d", stdin=b"foo\nbar\nfoo2\n")
    assert _str(stdout) == "bar\n"


def test_sed_delete_range():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed 2,3d", stdin=b"a\nb\nc\nd\n")
    assert _str(stdout) == "a\nd\n"


def test_sed_substitute_on_line():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed 2s/b/B/", stdin=b"a\nb\nc\n")
    assert _str(stdout) == "a\nB\nc\n"


def test_sed_substitute_by_regex_address():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed /foo/s/o/0/g", stdin=b"foo\nbar\nfool\n")
    assert _str(stdout) == "f00\nbar\nf00l\n"


def test_tr_complement_delete():
    ws = _ws()
    stdout, _ = _run_raw(ws, "tr -cd a-z", stdin=b"Hello World 123")
    assert _str(stdout) == "elloorld"


def test_tr_complement_translate():
    ws = _ws()
    stdout, _ = _run_raw(ws, "tr -c a-z *", stdin=b"Hello")
    out = _str(stdout)
    assert out[0] == "*"
    assert "ello" in out


def test_sed_append():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed '1aadded'", stdin=b"line1\nline2\n")
    out = _str(stdout)
    lines = out.splitlines()
    assert lines[0] == "line1"
    assert lines[1] == "added"
    assert lines[2] == "line2"


def test_sed_append_all_lines():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed 'aADDED'", stdin=b"a\nb\n")
    out = _str(stdout)
    lines = out.splitlines()
    assert lines == ["a", "ADDED", "b", "ADDED"]


def test_sed_print():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed 1p", stdin=b"a\nb\n")
    out = _str(stdout)
    assert out.count("a") == 2
    assert out.count("b") == 1


def test_sed_print_all():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed p", stdin=b"x\ny\n")
    out = _str(stdout)
    lines = out.splitlines()
    assert lines == ["x", "x", "y", "y"]


def test_sed_insert():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed '2iINSERTED'", stdin=b"a\nb\nc\n")
    out = _str(stdout)
    lines = out.splitlines()
    assert lines[0] == "a"
    assert lines[1] == "INSERTED"
    assert lines[2] == "b"


def test_sed_N_joins_lines():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed 'N;s/\\n/ /'", stdin=b"a\nb\n")
    assert "a b" in _str(stdout)


def test_sed_hold_swap():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed '1{h;d};2{x}'", stdin=b"first\nsecond\n")
    out = _str(stdout)
    assert "first" in out


def test_sed_hold_get():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed '1h;2g'", stdin=b"AAA\nBBB\n")
    out = _str(stdout)
    lines = out.strip().splitlines()
    assert lines[0] == "AAA"
    assert lines[1] == "AAA"


def test_sed_hold_append():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed 'H;${x;p}'", stdin=b"a\nb\nc\n")
    out = _str(stdout)
    assert "a" in out
    assert "b" in out
    assert "c" in out


def test_sed_D_multiline():
    ws = _ws()
    stdout, _ = _run_raw(ws, "sed 'N;P;D'", stdin=b"1\n2\n3\n")
    out = _str(stdout)
    assert "1" in out
    assert "2" in out
    assert "3" in out
