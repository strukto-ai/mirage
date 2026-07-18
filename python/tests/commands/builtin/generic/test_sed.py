import pytest

from mirage.commands.builtin.generic.sed import sed
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(resource_path=(path).strip("/"),
                    virtual=path,
                    directory=path,
                    resolved=True)


def _make_backend(files: dict[str, bytes]):
    store = dict(files)

    async def read_bytes(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            resource_path=(path).strip("/"), virtual=path, directory=path)
        if spec.virtual not in store:
            raise FileNotFoundError(spec.virtual)
        return store[spec.virtual]

    async def write_bytes(path, data):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            resource_path=(path).strip("/"), virtual=path, directory=path)
        store[spec.virtual] = data

    return read_bytes, write_bytes, store


@pytest.mark.asyncio
async def test_sed_stdin_simple_sub():
    rb, wb, _ = _make_backend({})
    output, _ = await sed(
        [],
        "s/hello/bye/",
        read_bytes=rb,
        write_bytes=wb,
        stdin=b"hello world\n",
    )
    assert output == b"bye world\n"


@pytest.mark.asyncio
async def test_sed_file_simple_sub_emits_output():
    rb, wb, _ = _make_backend({"/a.txt": b"hello world\n"})
    output, _ = await sed(
        [_spec("/a.txt")],
        "s/hello/bye/",
        read_bytes=rb,
        write_bytes=wb,
    )
    assert output == b"bye world\n"


@pytest.mark.asyncio
async def test_sed_inplace_simple_sub_writes_file():
    rb, wb, store = _make_backend({"/a.txt": b"hello world\n"})
    output, io = await sed(
        [_spec("/a.txt")],
        "s/hello/bye/",
        read_bytes=rb,
        write_bytes=wb,
        in_place=True,
    )
    assert output is None
    assert store["/a.txt"] == b"bye world\n"
    assert io.writes == {"/a.txt": b"bye world\n"}


@pytest.mark.asyncio
async def test_sed_inplace_multi_path_writes_all():
    rb, wb, store = _make_backend({
        "/a.txt": b"hello a\n",
        "/b.txt": b"hello b\n",
    })
    _output, io = await sed(
        [_spec("/a.txt"), _spec("/b.txt")],
        "s/hello/bye/",
        read_bytes=rb,
        write_bytes=wb,
        in_place=True,
    )
    assert store["/a.txt"] == b"bye a\n"
    assert store["/b.txt"] == b"bye b\n"
    assert set(io.writes.keys()) == {"/a.txt", "/b.txt"}


@pytest.mark.asyncio
async def test_sed_global_flag_replaces_all():
    rb, wb, _ = _make_backend({})
    output, _ = await sed(
        [],
        "s/a/X/g",
        read_bytes=rb,
        write_bytes=wb,
        stdin=b"banana\n",
    )
    assert output == b"bXnXnX\n"


@pytest.mark.asyncio
async def test_sed_first_match_only_by_default():
    rb, wb, _ = _make_backend({})
    output, _ = await sed(
        [],
        "s/a/X/",
        read_bytes=rb,
        write_bytes=wb,
        stdin=b"banana\n",
    )
    assert output == b"bXnana\n"


@pytest.mark.asyncio
async def test_sed_delete_program():
    """Delete command 'd' should drop matching lines."""
    rb, wb, _ = _make_backend({})
    output, _ = await sed(
        [],
        "/skip/d",
        read_bytes=rb,
        write_bytes=wb,
        stdin=b"keep\nskip me\nkeep too\n",
    )
    decoded = output.decode()
    assert "keep" in decoded
    assert "skip me" not in decoded


@pytest.mark.asyncio
async def test_sed_n_suppress_with_p():
    """-n suppresses default output; only explicit 'p' prints."""
    rb, wb, _ = _make_backend({})
    output, _ = await sed(
        [],
        "/match/p",
        read_bytes=rb,
        write_bytes=wb,
        stdin=b"no\nmatch line\nno\n",
        suppress=True,
    )
    decoded = output.decode()
    assert "match line" in decoded


@pytest.mark.asyncio
async def test_sed_no_paths_no_stdin_raises():
    rb, wb, _ = _make_backend({})
    with pytest.raises(ValueError, match="usage"):
        await sed([], "s/a/b/", read_bytes=rb, write_bytes=wb)


@pytest.mark.asyncio
async def test_sed_numeric_count_replaces_nth_occurrence():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "s/o/O/2",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"oooo\n")
    assert output == b"oOoo\n"


@pytest.mark.asyncio
async def test_sed_numeric_count_with_g_replaces_nth_onward():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "s/o/O/2g",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"oooo\n")
    assert output == b"oOOO\n"


@pytest.mark.asyncio
async def test_sed_count_is_per_line():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "s/o/O/2",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"oo\noo\n")
    assert output == b"oO\noO\n"


@pytest.mark.asyncio
async def test_sed_p_flag_prints_substituted_line_twice():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "s/hi/HI/p",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"hi\nbye\n")
    assert output == b"HI\nHI\nbye\n"


@pytest.mark.asyncio
async def test_sed_p_flag_under_suppress_prints_only_substituted():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "s/hi/HI/p",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"hi\nbye\n",
                          suppress=True)
    assert output == b"HI\n"


@pytest.mark.asyncio
async def test_sed_y_transliterate():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "y/el/ip/",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"hello\n")
    assert output == b"hippo\n"


@pytest.mark.asyncio
async def test_sed_y_mismatched_lengths_raises():
    rb, wb, _ = _make_backend({})
    with pytest.raises(ValueError, match="different lengths"):
        await sed([], "y/ab/x/", read_bytes=rb, write_bytes=wb, stdin=b"a\n")


@pytest.mark.asyncio
async def test_sed_c_no_address_changes_every_line():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "c\\\nX",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"a\nb\nc\n")
    assert output == b"X\nX\nX\n"


@pytest.mark.asyncio
async def test_sed_c_single_address():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "2c\\\nX",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"a\nb\nc\n")
    assert output == b"a\nX\nc\n"


@pytest.mark.asyncio
async def test_sed_c_range_emits_once():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "2,3c\\\nX",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"a\nb\nc\nd\n")
    assert output == b"a\nX\nd\n"


@pytest.mark.asyncio
async def test_sed_bre_group_and_backref():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          r"s/\(foo\)/[\1]/",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"foo\n")
    assert output == b"[foo]\n"


@pytest.mark.asyncio
async def test_sed_bre_plus_is_literal():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "s/a+/X/",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"a+b\n")
    assert output == b"Xb\n"


@pytest.mark.asyncio
async def test_sed_bre_backslash_plus_is_one_or_more():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          r"s/a\+/X/",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"aaab\n")
    assert output == b"Xb\n"


@pytest.mark.asyncio
async def test_sed_ere_group_and_plus():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          r"s/(foo)/[\1]/",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"foo\n",
                          extended=True)
    assert output == b"[foo]\n"
    output, _ = await sed([],
                          "s/a+/X/",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"aaab\n",
                          extended=True)
    assert output == b"Xb\n"


@pytest.mark.asyncio
async def test_sed_ere_address():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "/a+/d",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"aaa\nbbb\n",
                          extended=True)
    assert output == b"bbb\n"


@pytest.mark.asyncio
async def test_sed_negate_line():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "2!d",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"a\nb\nc\n")
    assert output == b"b\n"


@pytest.mark.asyncio
async def test_sed_negate_regex():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "/b/!d",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"a\nb\nc\n")
    assert output == b"b\n"


@pytest.mark.asyncio
async def test_sed_negate_last_with_suppress():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "$!p",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"a\nb\nc\n",
                          suppress=True)
    assert output == b"a\nb\n"


@pytest.mark.asyncio
async def test_sed_negate_range():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "1,2!s/./X/",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"a\nb\nc\nd\n")
    assert output == b"a\nb\nX\nX\n"


@pytest.mark.asyncio
async def test_sed_join_all_idiom():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          r":a;N;$!ba;s/\n/,/g",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"a\nb\nc\n")
    assert output == b"a,b,c\n"


@pytest.mark.asyncio
async def test_sed_hold_accumulate():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "H;${x;p}",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"a\nb\n",
                          suppress=True)
    assert output == b"\na\nb\n"


@pytest.mark.asyncio
async def test_sed_preserves_missing_final_newline():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          "s/o/O/",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"foo")
    assert output == b"fOo"


@pytest.mark.asyncio
async def test_sed_escaped_delimiter():
    rb, wb, _ = _make_backend({})
    output, _ = await sed([],
                          r"s/a\/b/c/",
                          read_bytes=rb,
                          write_bytes=wb,
                          stdin=b"a/b\n")
    assert output == b"c\n"


@pytest.mark.asyncio
async def test_sed_zero_count_rejected():
    rb, wb, _ = _make_backend({})
    with pytest.raises(ValueError, match="may not be zero"):
        await sed([], "s/o/O/0", read_bytes=rb, write_bytes=wb, stdin=b"oo\n")
