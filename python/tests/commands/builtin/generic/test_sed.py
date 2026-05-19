import pytest

from mirage.commands.builtin.generic.sed import sed
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(original=path, directory=path, resolved=True)


def _make_backend(files: dict[str, bytes]):
    store = dict(files)

    async def read_bytes(accessor, path, index=None):
        spec = path if isinstance(path, PathSpec) else PathSpec(original=path,
                                                                directory=path)
        if spec.original not in store:
            raise FileNotFoundError(spec.original)
        return store[spec.original]

    async def write_bytes(accessor, path, data, index=None):
        spec = path if isinstance(path, PathSpec) else PathSpec(original=path,
                                                                directory=path)
        store[spec.original] = data

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
