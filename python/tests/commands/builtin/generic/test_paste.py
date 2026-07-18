import pytest

from mirage.commands.builtin.generic.paste import paste
from mirage.io.types import materialize
from mirage.types import PathSpec


async def _read_empty_file(_path: PathSpec) -> bytes:
    return b""


@pytest.mark.asyncio
async def test_no_operand_uses_empty_standard_input():
    stdout, io = await paste([], read_bytes=_read_empty_file)

    assert await materialize(stdout) == b""
    assert io.exit_code == 0


@pytest.mark.parametrize("serial", [False, True])
@pytest.mark.asyncio
async def test_empty_file_produces_no_output(serial: bool):
    stdout, io = await paste(
        [PathSpec.from_str_path("/empty.txt")],
        read_bytes=_read_empty_file,
        serial=serial,
    )

    assert await materialize(stdout) == b""
    assert io.exit_code == 0
