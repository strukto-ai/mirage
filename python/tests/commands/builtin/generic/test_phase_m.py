import pytest

from mirage.commands.builtin.generic.nl import nl
from mirage.commands.builtin.generic.rev import rev
from mirage.commands.builtin.generic.sort import sort
from mirage.commands.builtin.generic.tac import tac
from mirage.commands.builtin.generic.tr import tr
from mirage.commands.builtin.generic.uniq import uniq
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(resource_path=(path).strip("/"),
                    virtual=path,
                    directory=path,
                    resolved=True)


def _make_backend(files: dict[str, bytes]):

    async def read_bytes(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            resource_path=(path).strip("/"), virtual=path, directory=path)
        if spec.virtual not in files:
            raise FileNotFoundError(spec.virtual)
        return files[spec.virtual]

    async def read_stream(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            resource_path=(path).strip("/"), virtual=path, directory=path)
        if spec.virtual not in files:
            raise FileNotFoundError(spec.virtual)
        yield files[spec.virtual]

    return read_bytes, read_stream


async def _drain(stdout) -> bytes:
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    return b"".join([c async for c in stdout])


@pytest.mark.asyncio
async def test_rev_stdin():
    rb, _ = _make_backend({})
    output, _ = await rev([], read_bytes=rb, stdin=b"hello\nworld\n")
    assert output == b"olleh\ndlrow\n"


@pytest.mark.asyncio
async def test_rev_multi_file_concatenates():
    rb, _ = _make_backend({"/a.txt": b"foo\n", "/b.txt": b"bar\n"})
    output, _ = await rev([_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb)
    assert output == b"oof\nrab\n"


@pytest.mark.asyncio
async def test_rev_missing_input_raises():
    rb, _ = _make_backend({})
    with pytest.raises(ValueError, match="missing operand"):
        await rev([], read_bytes=rb)


@pytest.mark.asyncio
async def test_tac_stdin_reverses_lines():
    _, rs = _make_backend({})
    output, _ = await tac([], read_stream=rs, stdin=b"a\nb\nc\n")
    decoded = (await _drain(output)).decode().splitlines()
    assert decoded == ["c", "b", "a"]


@pytest.mark.asyncio
async def test_tac_file_reverses_lines():
    _, rs = _make_backend({"/a.txt": b"a\nb\nc\n"})
    output, io = await tac([_spec("/a.txt")], read_stream=rs)
    decoded = (await _drain(output)).decode().splitlines()
    assert decoded == ["c", "b", "a"]
    assert io.cache == ["/a.txt"]


@pytest.mark.asyncio
async def test_sort_stdin_alpha():
    rb, _ = _make_backend({})
    output, _ = await sort([], read_bytes=rb, stdin=b"c\na\nb\n")
    assert output == b"a\nb\nc\n"


@pytest.mark.asyncio
async def test_sort_reverse():
    rb, _ = _make_backend({})
    output, _ = await sort([], read_bytes=rb, stdin=b"a\nb\nc\n", reverse=True)
    assert output == b"c\nb\na\n"


@pytest.mark.asyncio
async def test_sort_numeric():
    rb, _ = _make_backend({})
    output, _ = await sort([],
                           read_bytes=rb,
                           stdin=b"10\n2\n1\n",
                           numeric=True)
    assert output == b"1\n2\n10\n"


@pytest.mark.asyncio
async def test_sort_unique():
    rb, _ = _make_backend({})
    output, _ = await sort([],
                           read_bytes=rb,
                           stdin=b"b\na\nb\na\n",
                           unique=True)
    assert output == b"a\nb\n"


@pytest.mark.asyncio
async def test_sort_multi_file_merges():
    rb, _ = _make_backend({"/a.txt": b"c\na\n", "/b.txt": b"b\n"})
    output, _ = await sort([_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb)
    assert output == b"a\nb\nc\n"


@pytest.mark.asyncio
async def test_nl_stdin_default():
    _, rs = _make_backend({})
    output, _ = await nl([], read_stream=rs, stdin=b"alpha\nbeta\n")
    decoded = (await _drain(output)).decode()
    assert "1" in decoded and "alpha" in decoded
    assert "2" in decoded and "beta" in decoded


@pytest.mark.asyncio
async def test_nl_start_value():
    _, rs = _make_backend({})
    output, _ = await nl([],
                         read_stream=rs,
                         stdin=b"alpha\nbeta\n",
                         start_raw="100")
    decoded = (await _drain(output)).decode()
    assert "100" in decoded
    assert "101" in decoded


@pytest.mark.asyncio
async def test_nl_blank_lines_unnumbered_by_default():
    _, rs = _make_backend({})
    output, _ = await nl([], read_stream=rs, stdin=b"alpha\n\nbeta\n")
    decoded = (await _drain(output)).decode().splitlines()
    assert any("1" in ln and "alpha" in ln for ln in decoded)
    assert any("2" in ln and "beta" in ln for ln in decoded)


@pytest.mark.asyncio
async def test_tr_translate_charset():
    _, rs = _make_backend({})
    output, _ = await tr([], ("abc", "xyz"), read_stream=rs, stdin=b"cab")
    assert (await _drain(output)) == b"zxy"


@pytest.mark.asyncio
async def test_tr_delete():
    _, rs = _make_backend({})
    output, _ = await tr([], ("aeiou", ""),
                         read_stream=rs,
                         stdin=b"hello world",
                         delete=True)
    assert (await _drain(output)) == b"hll wrld"


@pytest.mark.asyncio
async def test_tr_squeeze():
    _, rs = _make_backend({})
    output, _ = await tr([], (" ", " "),
                         read_stream=rs,
                         stdin=b"a   b   c",
                         squeeze=True)
    assert (await _drain(output)) == b"a b c"


@pytest.mark.asyncio
async def test_tr_missing_args_raises():
    _, rs = _make_backend({})
    with pytest.raises(ValueError, match="usage"):
        await tr([], (), read_stream=rs)


@pytest.mark.asyncio
async def test_uniq_dedupes_adjacent():
    _, rs = _make_backend({})
    output, _ = await uniq([], read_stream=rs, stdin=b"a\na\nb\nb\nc\n")
    assert (await _drain(output)) == b"a\nb\nc\n"


@pytest.mark.asyncio
async def test_uniq_keeps_non_adjacent_dupes():
    """Real uniq only collapses adjacent duplicates."""
    _, rs = _make_backend({})
    output, _ = await uniq([], read_stream=rs, stdin=b"a\nb\na\n")
    assert (await _drain(output)) == b"a\nb\na\n"


@pytest.mark.asyncio
async def test_uniq_count():
    _, rs = _make_backend({})
    output, _ = await uniq([],
                           read_stream=rs,
                           stdin=b"a\na\na\nb\n",
                           count=True)
    decoded = (await _drain(output)).decode()
    assert "3" in decoded and "a" in decoded
    assert "1" in decoded and "b" in decoded


@pytest.mark.asyncio
async def test_uniq_duplicates_only():
    _, rs = _make_backend({})
    output, _ = await uniq([],
                           read_stream=rs,
                           stdin=b"a\na\nb\n",
                           duplicates_only=True)
    decoded = (await _drain(output)).decode()
    assert "a" in decoded
    assert "b" not in decoded


@pytest.mark.asyncio
async def test_uniq_unique_only():
    _, rs = _make_backend({})
    output, _ = await uniq([],
                           read_stream=rs,
                           stdin=b"a\na\nb\n",
                           unique_only=True)
    decoded = (await _drain(output)).decode()
    assert "b" in decoded
    assert decoded.count("a") == 0


@pytest.mark.asyncio
async def test_uniq_ignore_case():
    _, rs = _make_backend({})
    output, _ = await uniq([],
                           read_stream=rs,
                           stdin=b"Apple\napple\nBanana\n",
                           ignore_case=True)
    decoded = (await _drain(output)).decode().splitlines()
    assert len(decoded) == 2
