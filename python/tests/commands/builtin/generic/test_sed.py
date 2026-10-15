import pytest

from mirage.commands.builtin.generic.sed import sed
from mirage.io.stream import close_quietly
from mirage.io.types import materialize
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(
        vfs_path=(path).strip("/"), virtual=path, directory=path, resolved=True
    )


def _make_backend(files: dict[str, bytes]):
    store = dict(files)

    async def read_bytes(path):
        spec = (
            path
            if isinstance(path, PathSpec)
            else PathSpec(
                vfs_path=(path).strip("/"), virtual=path, directory=path
            )
        )
        if spec.virtual not in store:
            raise FileNotFoundError(spec.virtual)
        return store[spec.virtual]

    async def write_bytes(path, data):
        spec = (
            path
            if isinstance(path, PathSpec)
            else PathSpec(
                vfs_path=(path).strip("/"), virtual=path, directory=path
            )
        )
        store[spec.virtual] = data

    return read_bytes, write_bytes, store


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "script,stdin,out",
    [
        ("s/hi/HI/p", b"hi\nbye\n", b"HI\nHI\nbye\n"),
        ("s/a+/X/", b"a+b\n", b"Xb\n"),
        (r"/a\+b/d", b"x\na+b\naab\ny\n", b"x\na+b\ny\n"),
        (r"/a\/b/,/c\/d/d", b"x\na/b\nmid\nc/d\ny\n", b"x\ny\n"),
    ],
)
async def test_sed_scripts_over_stdin(script, stdin, out):
    # s///p prints a substituted line twice, a BRE `+` is literal, and an
    # address keeps its escapes, delimiters included.
    rb, wb, _ = _make_backend({})
    output, _ = await sed(
        [], script, read_stream=rb, write_bytes=wb, stdin=stdin
    )
    assert await materialize(output) == out


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "script,message",
    [
        (
            "y/ab/x/",
            b"sed: -e expression #1, char 7: strings for `y' "
            b"command are different lengths\n",
        ),
        (
            "/a\\/b",
            b"sed: -e expression #1, char 5: unterminated address regex\n",
        ),
    ],
)
async def test_sed_refuses_a_script(script, message):
    rb, wb, _ = _make_backend({})
    output, io = await sed(
        [], script, read_stream=rb, write_bytes=wb, stdin=b"a\n"
    )
    assert output is None
    assert io.exit_code == 1
    assert io.stderr == message


@pytest.mark.asyncio
async def test_sed_inplace_transliterate_writes_file():
    rb, wb, store = _make_backend({"/a.txt": b"one\ntwo\n"})
    output, _ = await sed(
        [_spec("/a.txt")],
        "y/o/0/",
        read_stream=rb,
        write_bytes=wb,
        in_place=True,
    )
    assert output is None
    assert store["/a.txt"] == b"0ne\ntw0\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "script,separate,out",
    [
        ("p", False, b"one\ntwo\nthree\n"),
        ("n;p", True, b"two\n"),
    ],
)
async def test_sed_reads_nothing_after_a_directory(script, separate, out):
    rb, wb, _ = _make_backend({"/f": b"one\ntwo\nthree\n", "/g": b"L1\nL2\n"})
    reads: list[str] = []

    async def read(path):
        reads.append(path.virtual)
        if path.virtual == "/d":
            raise IsADirectoryError(21, "Is a directory", "/d")
        return await rb(path)

    output, io = await sed(
        [_spec("/f"), _spec("/d"), _spec("/g")],
        script,
        read_stream=read,
        write_bytes=wb,
        suppress=True,
        separate=separate,
    )
    assert await materialize(output) == out
    assert io.exit_code == 4
    assert reads == ["/f", "/d"]


@pytest.mark.asyncio
@pytest.mark.parametrize("script,code", [("w /saved", 0), ("w /saved\nq7", 7)])
async def test_reached_writes_and_status_survive_early_output_close(
    script, code
):
    rb, wb, store = _make_backend({})
    output, io = await sed(
        [], script, read_stream=rb, write_bytes=wb, stdin=b"x\n"
    )
    assert await anext(output) == b"x\n"
    await output.aclose()
    assert store["/saved"] == b"x\n"
    assert io.exit_code == code


@pytest.mark.asyncio
async def test_repeated_stdin_operands_share_one_byte_cursor():
    rb, wb, _ = _make_backend({})
    output, io = await sed(
        [_spec("-"), _spec("-")],
        "",
        read_stream=rb,
        write_bytes=wb,
        stdin=b"x\n",
    )
    assert await materialize(output) == b"x\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_first_output_closes_inputs_without_reading_the_tail():
    opened = []
    closed = []

    async def source(path):
        opened.append(path.virtual)
        try:
            yield b"first\n"
            raise AssertionError(
                "stream fetched the tail before its first output"
            )
        finally:
            closed.append(path.virtual)

    paths = [PathSpec.from_str_path(f"/input{i}") for i in range(1)]
    output, io = await sed(
        paths, "s/first/yes/", read_stream=source, write_bytes=None
    )
    try:
        assert await anext(output) == b"yes\n"
    finally:
        await close_quietly(output)
    assert len(opened) == 1
    assert sorted(closed) == sorted(opened)
    assert io.exit_code == 0
