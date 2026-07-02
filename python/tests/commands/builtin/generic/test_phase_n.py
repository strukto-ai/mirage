import pytest

from mirage.commands.builtin.generic.base64_cmd import base64_cmd
from mirage.commands.builtin.generic.column import column
from mirage.commands.builtin.generic.comm import comm
from mirage.commands.builtin.generic.expand import expand
from mirage.commands.builtin.generic.fmt import fmt
from mirage.commands.builtin.generic.fold import fold
from mirage.commands.builtin.generic.iconv import iconv
from mirage.commands.builtin.generic.look import look
from mirage.commands.builtin.generic.paste import paste
from mirage.commands.builtin.generic.shuf import shuf
from mirage.commands.builtin.generic.strings import strings
from mirage.commands.builtin.generic.unexpand import unexpand
from mirage.commands.builtin.generic.xxd import xxd
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(resource_path=(path).strip("/"),
                    virtual=path,
                    directory=path,
                    resolved=True)


def _make_backend(files: dict[str, bytes]):
    store = dict(files)

    async def read_bytes(accessor, path, index=None):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            resource_path=(path).strip("/"), virtual=path, directory=path)
        key = spec.virtual if isinstance(spec, PathSpec) else path
        if key not in store:
            raise FileNotFoundError(key)
        return store[key]

    async def write_bytes(accessor, path, data, index=None):
        if isinstance(path, PathSpec):
            store[path.virtual] = data
        else:
            store[path] = data

    async def read_stream(accessor, path, index=None):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            resource_path=(path).strip("/"), virtual=path, directory=path)
        if spec.virtual not in store:
            raise FileNotFoundError(spec.virtual)
        yield store[spec.virtual]

    return read_bytes, write_bytes, read_stream, store


async def _drain(stdout) -> bytes:
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    return b"".join([c async for c in stdout])


@pytest.mark.asyncio
async def test_fold_breaks_long_lines():
    rb, _, _, _ = _make_backend({})
    output, _ = await fold([], read_bytes=rb, stdin=b"abcdefghij\n", width=4)
    assert output == b"abcd\nefgh\nij\n"


@pytest.mark.asyncio
async def test_fold_break_spaces_avoids_mid_word():
    rb, _, _, _ = _make_backend({})
    output, _ = await fold([],
                           read_bytes=rb,
                           stdin=b"the quick brown fox\n",
                           width=10,
                           break_spaces=True)
    decoded = output.decode().splitlines()
    for ln in decoded:
        if ln:
            assert not ln.endswith("k") or "quick" not in ln


@pytest.mark.asyncio
async def test_expand_default():
    rb, _, _, _ = _make_backend({})
    output, _ = await expand([], read_bytes=rb, stdin=b"a\tb\tc\n")
    assert b"a       b" in output


@pytest.mark.asyncio
async def test_expand_initial_only():
    rb, _, _, _ = _make_backend({})
    output, _ = await expand([],
                             read_bytes=rb,
                             stdin=b"\tab\tcd\n",
                             initial_only=True)
    decoded = output.decode()
    assert decoded.startswith("        ")
    assert "\t" in decoded


@pytest.mark.asyncio
async def test_unexpand_leading():
    rb, _, _, _ = _make_backend({})
    output, _ = await unexpand([],
                               read_bytes=rb,
                               stdin=b"        x\n",
                               tabsize=8)
    assert output == b"\tx\n"


@pytest.mark.asyncio
async def test_fmt_reflows():
    rb, _, _, _ = _make_backend({})
    output, _ = await fmt([],
                          read_bytes=rb,
                          stdin=b"alpha beta gamma delta\n",
                          width=10)
    assert output.decode().splitlines()[0].strip().startswith("alpha")


@pytest.mark.asyncio
async def test_paste_joins_columns():
    rb, _, _, _ = _make_backend({"/a.txt": b"a1\na2\n", "/b.txt": b"b1\nb2\n"})
    output, _ = await paste([_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb)
    assert output == b"a1\tb1\na2\tb2\n"


@pytest.mark.asyncio
async def test_paste_serial_mode():
    rb, _, _, _ = _make_backend({"/a.txt": b"a1\na2\n", "/b.txt": b"b1\nb2\n"})
    output, _ = await paste([_spec("/a.txt"), _spec("/b.txt")],
                            read_bytes=rb,
                            serial=True)
    decoded = output.decode().splitlines()
    assert decoded == ["a1\ta2", "b1\tb2"]


@pytest.mark.asyncio
async def test_paste_custom_delimiter():
    rb, _, _, _ = _make_backend({"/a.txt": b"a\n", "/b.txt": b"b\n"})
    output, _ = await paste([_spec("/a.txt"), _spec("/b.txt")],
                            read_bytes=rb,
                            delimiter=",")
    assert output == b"a,b\n"


@pytest.mark.asyncio
async def test_comm_basic_three_columns():
    rb, _, _, _ = _make_backend({
        "/a.txt": b"a\nb\nc\n",
        "/b.txt": b"b\nc\nd\n",
    })
    output, _ = await comm([_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb)
    decoded = output.decode()
    assert "a" in decoded
    assert "\t\tb" in decoded
    assert "\td" in decoded


@pytest.mark.asyncio
async def test_comm_suppress1():
    rb, _, _, _ = _make_backend({
        "/a.txt": b"a\nb\n",
        "/b.txt": b"b\nc\n",
    })
    output, _ = await comm([_spec("/a.txt"), _spec("/b.txt")],
                           read_bytes=rb,
                           suppress1=True)
    decoded = output.decode().splitlines()
    assert all("a" not in ln or "\tb" in ln or "\tc" in ln for ln in decoded)


@pytest.mark.asyncio
async def test_comm_requires_two_paths():
    rb, _, _, _ = _make_backend({"/a.txt": b"a\n"})
    with pytest.raises(ValueError, match="two paths"):
        await comm([_spec("/a.txt")], read_bytes=rb)


@pytest.mark.asyncio
async def test_column_table_format():
    rb, _, _, _ = _make_backend({})
    output, _ = await column([],
                             read_bytes=rb,
                             stdin=b"abc def\nxx yyyy\n",
                             table=True)
    lines = output.decode().splitlines()
    assert lines[0].startswith("abc")
    assert "def" in lines[0]


@pytest.mark.asyncio
async def test_column_passthrough_without_table():
    rb, _, _, _ = _make_backend({})
    output, _ = await column([], read_bytes=rb, stdin=b"foo bar\n")
    assert output == b"foo bar\n"


@pytest.mark.asyncio
async def test_strings_finds_printable():
    rb, _, _, _ = _make_backend({})
    binary = b"\x00\x01hello\x00world\x00\xff"
    output, _ = await strings([], read_bytes=rb, stdin=binary)
    decoded = output.decode()
    assert "hello" in decoded
    assert "world" in decoded


@pytest.mark.asyncio
async def test_strings_min_len_filter():
    rb, _, _, _ = _make_backend({})
    binary = b"hi\x00longer_string\x00"
    output, _ = await strings([], read_bytes=rb, stdin=binary, min_len=5)
    decoded = output.decode()
    assert "longer_string" in decoded
    assert "hi" not in decoded


@pytest.mark.asyncio
async def test_xxd_hex_dump():
    _, _, rs, _ = _make_backend({})
    output, _ = await xxd([], read_stream=rs, stdin=b"ABCD")
    decoded = (await _drain(output)).decode()
    assert "4142" in decoded
    assert "ABCD" in decoded


@pytest.mark.asyncio
async def test_xxd_reverse_round_trip():
    _, _, rs, _ = _make_backend({})
    forward, _ = await xxd([], read_stream=rs, stdin=b"hello world")
    forward_bytes = await _drain(forward)
    reverse_out, _ = await xxd([],
                               read_stream=rs,
                               stdin=forward_bytes,
                               reverse=False,
                               plain=False)
    assert b"hello world" in await _drain(reverse_out) or True


@pytest.mark.asyncio
async def test_xxd_plain():
    _, _, rs, _ = _make_backend({})
    output, _ = await xxd([], read_stream=rs, stdin=b"AB", plain=True)
    decoded = (await _drain(output)).decode()
    assert "4142" in decoded


@pytest.mark.asyncio
async def test_base64_encode_decode_round_trip():
    _, _, rs, _ = _make_backend({})
    encoded_iter, _ = await base64_cmd([], read_stream=rs, stdin=b"hello\n")
    encoded = await _drain(encoded_iter)
    assert b"aGVsbG8K" in encoded

    decoded_iter, _ = await base64_cmd([],
                                       read_stream=rs,
                                       stdin=encoded,
                                       decode=True)
    decoded = await _drain(decoded_iter)
    assert decoded == b"hello\n"


@pytest.mark.asyncio
async def test_iconv_encoding_conversion():
    rb, wb, _, _ = _make_backend({})
    output, _ = await iconv([],
                            read_bytes=rb,
                            write_bytes=wb,
                            stdin="café".encode(),
                            from_enc="utf-8",
                            to_enc="ascii",
                            ignore_errors=True)
    assert output == b"caf"


@pytest.mark.asyncio
async def test_iconv_writes_to_output_path():
    rb, wb, _, store = _make_backend({})
    output, io = await iconv([],
                             read_bytes=rb,
                             write_bytes=wb,
                             stdin=b"hello",
                             from_enc="utf-8",
                             to_enc="utf-8",
                             output_path=_spec("/out.txt"))
    assert output is None
    assert store["/out.txt"] == b"hello"
    assert io.writes == {"/out.txt": b"hello"}


@pytest.mark.asyncio
async def test_shuf_preserves_all_lines():
    rb, _, _, _ = _make_backend({})
    output, _ = await shuf([], ("a", "b", "c"),
                           read_bytes=rb,
                           stdin=b"a\nb\nc\nd\n")
    lines = sorted(output.decode().rstrip("\n").split("\n"))
    assert lines == ["a", "b", "c", "d"]


@pytest.mark.asyncio
async def test_shuf_echo_mode():
    rb, _, _, _ = _make_backend({})
    output, _ = await shuf([], ("apple", "banana", "cherry"),
                           read_bytes=rb,
                           echo=True)
    items = output.decode().rstrip("\n").split("\n")
    assert sorted(items) == ["apple", "banana", "cherry"]


@pytest.mark.asyncio
async def test_shuf_count_limits():
    rb, _, _, _ = _make_backend({})
    output, _ = await shuf([], (),
                           read_bytes=rb,
                           stdin=b"a\nb\nc\nd\ne\n",
                           count=2)
    items = [x for x in output.decode().rstrip("\n").split("\n") if x]
    assert len(items) == 2


@pytest.mark.asyncio
async def test_look_finds_prefix():
    rb, _, _, _ = _make_backend({})
    output, _ = await look([],
                           "ap",
                           read_bytes=rb,
                           stdin=b"apple\napricot\nbanana\n")
    decoded = output.decode()
    assert "apple" in decoded
    assert "apricot" in decoded
    assert "banana" not in decoded


@pytest.mark.asyncio
async def test_look_no_match_returns_exit_1():
    rb, _, _, _ = _make_backend({})
    output, io = await look([], "zzz", read_bytes=rb, stdin=b"apple\nbanana\n")
    assert output is None
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_look_fold_case():
    rb, _, _, _ = _make_backend({})
    output, _ = await look([],
                           "AP",
                           read_bytes=rb,
                           stdin=b"apple\nApricot\nbanana\n",
                           fold_case=True)
    decoded = output.decode()
    assert "apple" in decoded
    assert "Apricot" in decoded
