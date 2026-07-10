import pytest

from mirage.commands.builtin.generic.awk import awk
from mirage.commands.errors import UsageError
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(resource_path=(path).strip("/"),
                    virtual=path,
                    directory=path,
                    resolved=True)


def _make_backend(files: dict[str, bytes]):

    async def read_bytes(accessor, path, index=None):
        key = path.virtual if isinstance(path, PathSpec) else path
        if key not in files:
            raise FileNotFoundError(key)
        return files[key]

    async def read_stream(accessor, path, index=None):
        assert isinstance(path, PathSpec)
        key = path.virtual
        if key not in files:
            raise FileNotFoundError(key)
        yield files[key]

    return read_bytes, read_stream


async def _drain(stdout) -> bytes:
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    return b"".join([c async for c in stdout])


@pytest.mark.asyncio
async def test_awk_stdin_print_field():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print $1}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"alpha beta\ngamma delta\n",
    )
    assert (await _drain(output)).decode() == "alpha\ngamma\n"


@pytest.mark.asyncio
async def test_awk_field_separator():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print $2}", ),
        {"F": ","},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"a,b,c\nd,e,f\n",
    )
    assert (await _drain(output)).decode() == "b\ne\n"


@pytest.mark.asyncio
async def test_awk_variable_assignment():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print x}", ),
        {"v": ["x=hello"]},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
    )
    assert (await _drain(output)).decode() == "hello\n"


@pytest.mark.asyncio
async def test_awk_numeric_comparison():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("$1 > 2 {print $1}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"1\n2\n3\n4\n",
    )
    assert (await _drain(output)).decode() == "3\n4\n"


@pytest.mark.asyncio
async def test_awk_regex_condition():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("/foo/ {print $0}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"foo bar\nbaz\nfoobar\n",
    )
    assert (await _drain(output)).decode() == "foo bar\nfoobar\n"


@pytest.mark.asyncio
async def test_awk_end_block_accumulator():
    """sum += $1 with END {print sum} should emit total."""
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{sum += $1} END {print sum}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"10\n20\n30\n",
    )
    assert (await _drain(output)).decode() == "60\n"


@pytest.mark.asyncio
async def test_awk_reads_from_file():
    rb, rs = _make_backend({"/data.txt": b"hello world\n"})
    output, io = await awk(
        [_spec("/data.txt")],
        ("{print $2}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain(output)).decode() == "world\n"
    assert io.cache == ["/data.txt"]


@pytest.mark.asyncio
async def test_awk_program_file_overrides_inline():
    rb, rs = _make_backend({
        "/prog.awk": b"{print $1}\n",
        "/data.txt": b"alpha beta\n",
    })
    output, _ = await awk(
        [_spec("/data.txt")],
        (),
        {"f": _spec("/prog.awk")},
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain(output)).decode() == "alpha\n"


@pytest.mark.asyncio
async def test_awk_missing_program_raises_usage_error():
    rb, rs = _make_backend({})
    with pytest.raises(UsageError, match="usage"):
        await awk([], (), None, read_bytes=rb, read_stream=rs)


@pytest.mark.asyncio
async def test_awk_default_fs_collapses_whitespace():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print $2}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"a   b\n\tx\t \ty\n",
    )
    assert (await _drain(output)).decode() == "b\ny\n"


@pytest.mark.asyncio
async def test_awk_explicit_single_space_fs_collapses_whitespace():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print $2}", ),
        {"F": " "},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"a   b\n",
    )
    assert (await _drain(output)).decode() == "b\n"


@pytest.mark.asyncio
async def test_awk_empty_fs_splits_characters():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print $2}", ),
        {"F": ""},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"abc\n",
    )
    assert (await _drain(output)).decode() == "b\n"


@pytest.mark.asyncio
async def test_awk_processes_all_files_with_continuous_nr():
    rb, rs = _make_backend({
        "/a.txt": b"one\ntwo\n",
        "/b.txt": b"three\n",
    })
    output, io = await awk(
        [_spec("/a.txt"), _spec("/b.txt")],
        ("{print NR, $1}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain(output)).decode() == "1 one\n2 two\n3 three\n"
    assert io.cache == ["/a.txt", "/b.txt"]


@pytest.mark.asyncio
async def test_awk_multifile_no_trailing_newline_keeps_lines_separate():
    rb, rs = _make_backend({
        "/a.txt": b"one",
        "/b.txt": b"two\n",
    })
    output, _ = await awk(
        [_spec("/a.txt"), _spec("/b.txt")],
        ("{print NR, $1}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain(output)).decode() == "1 one\n2 two\n"


@pytest.mark.asyncio
async def test_awk_repeated_v_assignments():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print a, b}", ),
        {"v": ["a=1", "b=2"]},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
    )
    assert (await _drain(output)).decode() == "1 2\n"


@pytest.mark.asyncio
async def test_awk_v_value_containing_equals():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print x}", ),
        {"v": ["x=a=b"]},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
    )
    assert (await _drain(output)).decode() == "a=b\n"


@pytest.mark.asyncio
async def test_awk_print_empty_string_emits_blank_line():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ('{print ""}', ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"one\ntwo\n",
    )
    assert (await _drain(output)).decode() == "\n\n"


@pytest.mark.asyncio
async def test_awk_action_without_print_emits_nothing():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{x += 1}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"one\ntwo\n",
    )
    assert (await _drain(output)).decode() == ""


@pytest.mark.asyncio
async def test_awk_brace_literal_in_print():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ('{print "}"}', ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
    )
    assert (await _drain(output)).decode() == "}\n"


@pytest.mark.asyncio
async def test_awk_accumulator_non_numeric_coerces():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{sum += $1} END {print sum}", ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"3\nabc\n2.5x\n",
    )
    assert (await _drain(output)).decode() == "5.5\n"


@pytest.mark.asyncio
async def test_awk_program_file_missing_raises_usage_error():
    rb, rs = _make_backend({"/data.txt": b"x\n"})
    with pytest.raises(UsageError, match="No such file"):
        await awk(
            [_spec("/data.txt")],
            (),
            {"f": _spec("/missing.awk")},
            read_bytes=rb,
            read_stream=rs,
        )


@pytest.mark.asyncio
async def test_awk_program_file_with_multiple_data_files():
    rb, rs = _make_backend({
        "/prog.awk": b"{print NR, $1}\n",
        "/a.txt": b"one\n",
        "/b.txt": b"two\n",
    })
    output, io = await awk(
        [_spec("/a.txt"), _spec("/b.txt")],
        (),
        {"f": _spec("/prog.awk")},
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain(output)).decode() == "1 one\n2 two\n"
    assert io.cache == ["/a.txt", "/b.txt"]


@pytest.mark.asyncio
async def test_awk_begin_end_resolve_v_variables():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("BEGIN {print x} END {print x}", ),
        {"v": ["x=hi"]},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
    )
    assert (await _drain(output)).decode() == "hi\nhi\n"


@pytest.mark.asyncio
async def test_awk_duplicate_v_last_wins():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ("{print x}", ),
        {"v": ["x=first", "x=second"]},
        read_bytes=rb,
        read_stream=rs,
        stdin=b"line\n",
    )
    assert (await _drain(output)).decode() == "second\n"


@pytest.mark.asyncio
async def test_awk_begin_bare_print_emits_blank_line():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ('BEGIN {print} {print $1}', ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"a\n",
    )
    assert (await _drain(output)).decode() == "\na\n"


@pytest.mark.asyncio
async def test_awk_brace_literal_with_condition():
    rb, rs = _make_backend({})
    output, _ = await awk(
        [],
        ('/x/ {print "}"}', ),
        None,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"x\ny\n",
    )
    assert (await _drain(output)).decode() == "}\n"
