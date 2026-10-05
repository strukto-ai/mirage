import pytest

from mirage.commands.builtin.generic.sha256sum import sha256sum_generic
from mirage.commands.config import CommandOpts
from mirage.types import ContentType, FileStat, FileType, PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(
        vfs_path=path.strip("/"), virtual=path, directory=path, resolved=True
    )


def _backend(files: dict[str, bytes]):
    async def stat(path: PathSpec) -> FileStat:
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        return FileStat(
            name=path.virtual,
            size=len(files[path.virtual]),
            type=FileType.FILE,
            content=ContentType.TEXT,
        )

    async def read_stream(path: PathSpec):
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        yield files[path.virtual]

    return stat, read_stream


async def _drain(stdout) -> bytes:
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    return b"".join([c async for c in stdout])


@pytest.mark.asyncio
async def test_sha256sum_check_failing():
    stat, read_stream = _backend(
        {
            "/manifest.sha256": b"0" * 64 + b"  /file.txt\n",
            "/file.txt": b"actual content",
        }
    )
    output, io = await sha256sum_generic(
        [_spec("/manifest.sha256")],
        [],
        CommandOpts(flags={"check": True}),
        stat,
        read_stream,
    )
    assert b"/file.txt: FAILED" in await _drain(output)
    assert io.exit_code == 1
