import pytest

from mirage.commands.builtin.generic.iconv import iconv
from mirage.io.types import ByteSource, materialize
from mirage.types import PathSpec


async def _unused_read_stream(path):
    raise AssertionError(f"iconv read {path} although stdin was given")


def _store():
    store: dict[str, bytes] = {}

    async def write_bytes(path: PathSpec, data: ByteSource) -> None:
        store[path.virtual] = await materialize(data)

    return store, write_bytes


@pytest.mark.asyncio
async def test_iconv_writes_to_output_path():
    store, write_bytes = _store()
    output, io = await iconv(
        [],
        read_stream=_unused_read_stream,
        write_bytes=write_bytes,
        stdin=b"hello",
        from_enc="utf-8",
        to_enc="utf-8",
        output_path=PathSpec(
            vfs_path="out.txt",
            virtual="/out.txt",
            directory="/out.txt",
            resolved=True,
        ),
    )
    assert output is None
    assert store["/out.txt"] == b"hello"
    assert io.exit_code == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stdin,omit,expected,code",
    [
        ("aあ".encode(), False, b'a\x1b$B$"\x1b(B', 0),
        ("あéx".encode(), False, b'\x1b$B$"\x1b(B', 1),
        ("あéx".encode(), True, b'\x1b$B$"\x1b(Bx', 1),
    ],
)
async def test_iconv_closes_a_stateful_target(stdin, omit, expected, code):
    """glibc writes ISO-2022-JP's reset sequence even after an error."""
    _, write_bytes = _store()
    output, io = await iconv(
        [],
        read_stream=_unused_read_stream,
        write_bytes=write_bytes,
        stdin=stdin,
        from_enc="utf-8",
        to_enc="ISO-2022-JP",
        ignore_errors=omit,
    )
    assert (await materialize(output), io.exit_code) == (expected, code)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw,source,target,expected,code",
    [
        ("hé😀".encode(), "UTF-8", "UTF-16LE", "hé😀".encode("utf-16-le"), 0),
        (b"\xff\xfeh\x00\xe9\x00", "UTF-16", "UTF-8", "hé".encode(), 0),
        (b"a\xe2\x82", "UTF-8", "UTF-8", b"a", 1),
        (b"a\xffb", "UTF-8", "UTF-8", b"a", 1),
        (b"a\0\0\0", "UTF-32", "UTF-8", b"a", 0),
        (b"\0\0\xfe\xff\0\0\0a", "UTF-32", "UTF-8", b"a", 0),
        (b"a\0\0\0\0\0\x11\0b\0\0\0", "UTF-32", "UTF-8", b"a", 1),
    ],
)
async def test_iconv_preserves_decoding_state_between_single_byte_chunks(
    raw, source, target, expected, code
):
    closed = []

    async def input_chunks():
        try:
            for byte in raw:
                yield bytes([byte])
        finally:
            closed.append(True)

    _, write = _store()
    out, io = await iconv(
        [],
        read_stream=_unused_read_stream,
        write_bytes=write,
        stdin=input_chunks(),
        from_enc=source,
        to_enc=target,
    )
    assert await materialize(out) == expected
    assert io.exit_code == code
    assert closed == [True]
