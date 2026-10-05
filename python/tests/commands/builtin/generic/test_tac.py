import pytest

from mirage.commands.builtin.generic.tac import tac
from mirage.types import PathSpec


def _read_stream(files: dict[str, bytes]):
    async def read_stream(path: PathSpec):
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        yield files[path.virtual]

    return read_stream


async def _drain(stdout) -> list[str]:
    if isinstance(stdout, bytes):
        return stdout.decode().splitlines()
    return b"".join([c async for c in stdout]).decode().splitlines()


@pytest.mark.asyncio
async def test_tac_stdin_reverses_lines():
    output, _ = await tac([], read_stream=_read_stream({}), stdin=b"a\nb\nc\n")
    assert await _drain(output) == ["c", "b", "a"]


@pytest.mark.asyncio
async def test_tac_file_reverses_lines():
    path = PathSpec(
        vfs_path="a.txt", virtual="/a.txt", directory="/a.txt", resolved=True
    )
    output, _ = await tac(
        [path], read_stream=_read_stream({"/a.txt": b"a\nb\nc\n"})
    )
    assert await _drain(output) == ["c", "b", "a"]
