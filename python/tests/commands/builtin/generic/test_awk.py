from collections.abc import AsyncIterator

import pytest

from mirage.commands.builtin.generic.awk import awk_generic
from mirage.commands.errors import UsageError
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(
        vfs_path=(path).strip("/"), virtual=path, directory=path, resolved=True
    )


def _make_backend(files: dict[str, bytes]):
    async def read_stream(path):
        assert isinstance(path, PathSpec)
        key = path.virtual
        if key not in files:
            raise FileNotFoundError(key)
        yield files[key]

    return read_stream


async def _drain(stdout) -> bytes:
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    return b"".join([c async for c in stdout])


@pytest.mark.parametrize(
    "f, files, data, expected",
    [
        (
            _spec("/prog.awk"),
            {"/prog.awk": b"{print $1}\n", "/data.txt": b"alpha beta\n"},
            ["/data.txt"],
            "alpha\n",
        ),
        (
            _spec("/prog.awk"),
            {
                "/prog.awk": b"{print NR, $1}\n",
                "/a.txt": b"one\n",
                "/b.txt": b"two\n",
            },
            ["/a.txt", "/b.txt"],
            "1 one\n2 two\n",
        ),
        (
            [_spec("/p1.awk"), _spec("/p2.awk")],
            {
                "/p1.awk": b"{sum += $1}\n",
                "/p2.awk": b"END {print sum}\n",
                "/nums.txt": b"1\n2\n3\n",
            },
            ["/nums.txt"],
            "6\n",
        ),
    ],
)
@pytest.mark.asyncio
async def test_awk_runs_the_program_files(f, files, data, expected):
    rs = _make_backend(files)
    output, _ = await awk_generic(
        [_spec(path) for path in data],
        (),
        {"f": f},
        stream=rs,
    )
    assert (await _drain(output)).decode() == expected


@pytest.mark.asyncio
async def test_awk_empty_fs_splits_characters():
    rs = _make_backend({})
    output, _ = await awk_generic(
        [],
        ("{print $2}",),
        {"F": ""},
        stream=rs,
        stdin=b"abc\n",
    )
    assert (await _drain(output)).decode() == "b\n"


@pytest.mark.asyncio
async def test_awk_processes_all_files_with_continuous_nr():
    rs = _make_backend(
        {
            "/a.txt": b"one\ntwo\n",
            "/b.txt": b"three\n",
        }
    )
    output, _ = await awk_generic(
        [_spec("/a.txt"), _spec("/b.txt")],
        ("{print NR, $1}",),
        None,
        stream=rs,
    )
    assert (await _drain(output)).decode() == "1 one\n2 two\n3 three\n"


@pytest.mark.asyncio
async def test_awk_program_file_missing_raises_usage_error():
    rs = _make_backend({"/data.txt": b"x\n"})
    with pytest.raises(UsageError, match="No such file"):
        await awk_generic(
            [_spec("/data.txt")],
            (),
            {"f": _spec("/missing.awk")},
            stream=rs,
        )


async def _run_stdin(program: str, stdin: bytes, flags=None) -> str:
    rs = _make_backend({})
    output, _ = await awk_generic(
        [],
        (program,),
        flags,
        stream=rs,
        stdin=stdin,
    )
    return (await _drain(output)).decode()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "program,stdin,expected",
    [
        ("{print $2}", b"a   b\n\tx\t \ty\n", "b\ny\n"),
        ("$1 ~ /a{2}/ {print $2}", b"aa 1\na 2\n", "1\n"),
    ],
)
async def test_awk_runs_a_program_on_stdin(program, stdin, expected):
    assert await _run_stdin(program, stdin) == expected


@pytest.mark.asyncio
async def test_awk_without_a_program_raises_usage():
    rs = _make_backend({})
    with pytest.raises(UsageError, match="usage"):
        await awk_generic([], (), None, stream=rs, stdin=b"a\n")


@pytest.mark.parametrize(
    "program, message",
    [
        (
            "$1 ~ /(a/ {print}",
            b"awk: syntax error in regular expression (a at source line 1\n",
        ),
        (
            "/\u00e9(/",
            b"awk: syntax error in regular expression \xc3\xa9( at source "
            b"line 1\n",
        ),
        (
            "BEGIN{print 1 \udcff}",
            b"awk: syntax error: unexpected character '\xff'\n",
        ),
        ("{print $(}", b"awk: syntax error at '}': expected an expression\n"),
    ],
)
@pytest.mark.asyncio
async def test_awk_syntax_errors_exit_2_naming_the_program_bytes(
    program, message
):
    assert await _run_io(program, b"a\n") == ("", 2, message)


async def _run_io(program: str, stdin: bytes) -> tuple[str, int, bytes]:
    rs = _make_backend({})
    output, io = await awk_generic(
        [],
        (program,),
        None,
        stream=rs,
        stdin=stdin,
    )
    out = (await _drain(output)).decode()
    err = io.stderr if isinstance(io.stderr, bytes) else b""
    return out, io.exit_code, err


@pytest.mark.parametrize(
    "program,message",
    [
        ('{print > "out.txt"}', "awk: file output requires a workspace\n"),
        ('{system("ls")}', "awk: running a command requires a workspace\n"),
        ('{"ls" | getline}', "awk: running a command requires a workspace\n"),
        ('{print | "cat"}', "awk: running a command requires a workspace\n"),
    ],
)
@pytest.mark.asyncio
async def test_awk_refuses_what_it_cannot_reach(program, message):
    out, code, err = await _run_io(program, b"a\n")
    assert (out, code, err) == ("", 2, message.encode())


async def _chunked(parts: tuple[bytes, ...]) -> AsyncIterator[bytes]:
    for part in parts:
        yield part


@pytest.mark.parametrize(
    "parts,rs,expected",
    [
        ((b"a\n", b"\nb\n"), "", "a|b|"),
        ((b"a1", b"2b"), "[0-9]+", "a|b|"),
        ((b"a:", b"b"), ":", "a|b|"),
        ((b"h\xc3", b"\xa9:x"), ":", "h\u00e9|x|"),
    ],
)
@pytest.mark.asyncio
async def test_awk_rs_holds_a_record_across_chunks(parts, rs, expected):
    read_stream = _make_backend({})
    output, _ = await awk_generic(
        [],
        ('{printf "%s|", $0}',),
        {"v": [f"RS={rs}"]},
        stream=read_stream,
        stdin=_chunked(parts),
    )
    assert (await _drain(output)).decode() == expected


@pytest.mark.asyncio
async def test_awk_rs_paragraph_separator_is_the_whole_newline_run():
    read_stream = _make_backend({})
    output, _ = await awk_generic(
        [],
        ('{printf "%s|", $0; RS="\\n"}',),
        {"v": ["RS="]},
        stream=read_stream,
        stdin=_chunked((b"a\n\n", b"\nb\n")),
    )
    assert (await _drain(output)).decode() == "a|b|"
