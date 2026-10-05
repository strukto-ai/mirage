import pytest

from mirage.commands.builtin.generic.file import file_cmd
from mirage.types import ContentType, FileStat, FileType, PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual=path, directory=path, vfs_path=path.strip("/"))


def _make_backend(files: dict[str, tuple[bytes, ContentType]], dirs: set[str]):
    async def stat_fn(p: PathSpec) -> FileStat:
        if p.virtual in dirs:
            return FileStat(name=p.virtual, type=FileType.DIRECTORY, size=0)
        if p.virtual in files:
            data, ftype = files[p.virtual]
            return FileStat(
                name=p.virtual,
                type=FileType.FILE,
                content=ftype,
                size=len(data),
            )
        raise FileNotFoundError(p.virtual)

    async def read_bytes(p: PathSpec) -> bytes:
        return files[p.virtual][0]

    return stat_fn, read_bytes


@pytest.mark.asyncio
async def test_file_missing_operand_raises():
    stat_fn, read_bytes = _make_backend({}, set())
    with pytest.raises(ValueError):
        await file_cmd([], read_bytes=read_bytes, stat_fn=stat_fn)


@pytest.mark.asyncio
async def test_file_read_error_logs_and_falls_back():
    async def stat_fn(path):
        return FileStat(
            name="x", size=1, type=FileType.FILE, content=ContentType.TEXT
        )

    async def read_bytes(path):
        raise OSError("denied")

    out, _ = await file_cmd(
        [_spec("x")], read_bytes=read_bytes, stat_fn=stat_fn
    )
    assert b"x:" in out
