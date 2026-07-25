import pytest

from mirage.commands.builtin.generic.csplit import csplit
from mirage.commands.builtin.generic.join import join_cmd
from mirage.commands.builtin.generic.split import split
from mirage.commands.builtin.generic.tee import tee
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(resource_path=(path).strip("/"),
                    virtual=path,
                    directory=path,
                    resolved=True)


def _make_backend(files: dict[str, bytes]):
    store = dict(files)

    async def read_bytes(path):
        key = path.virtual if isinstance(path, PathSpec) else path
        if key not in store:
            raise FileNotFoundError(key)
        return store[key]

    async def write_bytes(path, data):
        key = path.virtual if isinstance(path, PathSpec) else path
        store[key] = data

    async def read_stream(path):
        key = path.virtual if isinstance(path, PathSpec) else path
        if key not in store:
            raise FileNotFoundError(key)
        yield store[key]

    return read_bytes, write_bytes, read_stream, store


@pytest.mark.asyncio
async def test_split_by_lines_default():
    _, wb, rs, _ = _make_backend({})
    _, io = await split([],
                        read_stream=rs,
                        write_bytes=wb,
                        stdin=b"a\nb\nc\nd\ne\n",
                        lines_per_file=2)
    assert len(io.writes) == 3
    assert b"a\nb\n" in io.writes["xaa"]
    assert b"c\nd\n" in io.writes["xab"]


@pytest.mark.asyncio
async def test_split_by_bytes():
    _, wb, rs, _ = _make_backend({})
    _, io = await split([],
                        read_stream=rs,
                        write_bytes=wb,
                        stdin=b"abcdefghij",
                        byte_limit=4)
    assert io.writes["xaa"] == b"abcd"
    assert io.writes["xab"] == b"efgh"
    assert io.writes["xac"] == b"ij"


@pytest.mark.asyncio
async def test_split_n_chunks():
    _, wb, rs, _ = _make_backend({})
    _, io = await split([],
                        read_stream=rs,
                        write_bytes=wb,
                        stdin=b"aaaabbbbcc",
                        n_chunks=3)
    assert len(io.writes) == 3


@pytest.mark.asyncio
async def test_split_numeric_suffix():
    _, wb, rs, _ = _make_backend({})
    _, io = await split([],
                        read_stream=rs,
                        write_bytes=wb,
                        stdin=b"a\nb\n",
                        lines_per_file=1,
                        numeric_suffix=True)
    assert "x00" in io.writes
    assert "x01" in io.writes


@pytest.mark.asyncio
async def test_csplit_by_line_number():
    rb, wb, _, _ = _make_backend({})
    output, io = await csplit([], ("3", ),
                              read_bytes=rb,
                              write_bytes=wb,
                              stdin=b"a\nb\nc\nd\ne\n")
    assert "xx00" in io.writes
    assert "xx01" in io.writes
    assert b"a\nb\n" == io.writes["xx00"]


@pytest.mark.asyncio
async def test_csplit_by_regex():
    rb, wb, _, _ = _make_backend({})
    _, io = await csplit([], ("/MARK/", ),
                         read_bytes=rb,
                         write_bytes=wb,
                         stdin=b"a\nb\nMARK\nc\nd\n")
    assert b"a\nb\n" == io.writes["xx00"]
    assert b"MARK\nc\nd\n" == io.writes["xx01"]


@pytest.mark.asyncio
async def test_csplit_silent_suppresses_size_output():
    rb, wb, _, _ = _make_backend({})
    output, _ = await csplit([], ("2", ),
                             read_bytes=rb,
                             write_bytes=wb,
                             stdin=b"a\nb\nc\n",
                             silent=True)
    assert output == b""


@pytest.mark.asyncio
async def test_csplit_custom_prefix_and_digits():
    rb, wb, _, _ = _make_backend({})
    _, io = await csplit([], ("2", ),
                         read_bytes=rb,
                         write_bytes=wb,
                         stdin=b"a\nb\nc\n",
                         prefix="part_",
                         digits=3)
    assert "part_000" in io.writes
    assert "part_001" in io.writes


@pytest.mark.asyncio
async def test_join_basic_inner_join():
    rb, _, _, _ = _make_backend({
        "/a.txt": b"1 alpha\n2 beta\n3 gamma\n",
        "/b.txt": b"1 x\n2 y\n4 z\n",
    })
    output, _ = await join_cmd(
        [_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb)
    decoded = output.decode()
    assert "1 alpha x" in decoded
    assert "2 beta y" in decoded
    assert "3" not in decoded.split("\n")[0]
    assert "4" not in decoded


@pytest.mark.asyncio
async def test_join_requires_two_paths():
    rb, _, _, _ = _make_backend({"/a.txt": b"x"})
    with pytest.raises(ValueError, match="two paths"):
        await join_cmd([_spec("/a.txt")], read_bytes=rb)


@pytest.mark.asyncio
async def test_join_custom_separator():
    rb, _, _, _ = _make_backend({
        "/a.txt": b"1,alpha\n2,beta\n",
        "/b.txt": b"1,x\n2,y\n",
    })
    output, _ = await join_cmd(
        [_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb, separator=",")
    decoded = output.decode()
    assert "1,alpha,x" in decoded


@pytest.mark.asyncio
async def test_join_outer_via_a_flag():
    rb, _, _, _ = _make_backend({
        "/a.txt": b"1 alpha\n2 beta\n3 gamma\n",
        "/b.txt": b"1 x\n",
    })
    output, _ = await join_cmd(
        [_spec("/a.txt"), _spec("/b.txt")], read_bytes=rb, also_unpairable="1")
    decoded = output.decode()
    assert "2 beta" in decoded
    assert "3 gamma" in decoded


@pytest.mark.asyncio
async def test_tee_writes_to_file_and_passes_through():
    _, wb, rs, store = _make_backend({})
    output, io = await tee([_spec("/out.txt")], (),
                           read_stream=rs,
                           write_bytes=wb,
                           stdin=b"hello tee")
    assert output == b"hello tee"
    assert store["/out.txt"] == b"hello tee"
    assert io.writes == {"/out.txt": b"hello tee"}


@pytest.mark.asyncio
async def test_tee_append_concatenates():
    _, wb, rs, store = _make_backend({"/out.txt": b"existing\n"})
    output, _ = await tee([_spec("/out.txt")], (),
                          read_stream=rs,
                          write_bytes=wb,
                          stdin=b"new",
                          flags={"a": True})
    assert store["/out.txt"] == b"existing\nnew"
    assert output == b"new"


@pytest.mark.asyncio
async def test_tee_missing_path_raises():
    _, wb, rs, _ = _make_backend({})
    with pytest.raises(ValueError, match="missing operand"):
        await tee([], (), read_stream=rs, write_bytes=wb, stdin=b"data")
