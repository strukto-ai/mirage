import pytest

from mirage.commands.builtin.generic.tr import tr_generic
from mirage.io.stream import materialize


def _unused_read_stream(_path):
    raise AssertionError("read_stream should not be called for stdin input")


async def _run(texts, flags, data):
    source, io = await tr_generic(
        [],
        tuple(texts),
        read_stream=_unused_read_stream,
        stdin=data,
        flags=flags,
    )
    return io.exit_code, (await materialize(source)).decode()


@pytest.mark.asyncio
async def test_default_pads_set2_to_set1_length():
    _, out = await _run(["abcde", "xy"], {}, b"abcde")
    assert out == "xyyyy"


@pytest.mark.asyncio
async def test_complement_long_form():
    _, comp = await _run(["0-9", "_"], {"complement": True}, b"abc123")
    assert comp == "___123"


@pytest.mark.asyncio
async def test_delete_without_squeeze_names_the_second_operand_as_extra():
    with pytest.raises(
        ValueError, match="extra operand 'b'\nOnly one string may be given"
    ):
        await _run(["a", "b"], {"delete": True}, b"x")
    with pytest.raises(Exception, match=r"extra operand 'c'\nTry"):
        await _run(["a", "b", "c"], {}, b"x")
