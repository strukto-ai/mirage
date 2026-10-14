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

    async def stream(p: PathSpec):
        yield files[p.virtual][0]

    return stat_fn, stream


@pytest.mark.asyncio
async def test_file_missing_operand_raises():
    stat_fn, stream = _make_backend({}, set())
    with pytest.raises(ValueError):
        await file_cmd([], stream=stream, stat_fn=stat_fn)


@pytest.mark.asyncio
async def test_file_read_error_logs_and_falls_back():
    async def stat_fn(path):
        return FileStat(
            name="x", size=1, type=FileType.FILE, content=ContentType.TEXT
        )

    async def stream(path):
        raise OSError("denied")
        yield b""

    out, _ = await file_cmd([_spec("x")], stream=stream, stat_fn=stat_fn)
    assert b"x:" in out


@pytest.mark.asyncio
async def test_file_reads_only_the_first_bytes():
    pulled: list[int] = []

    async def stat_fn(path):
        return FileStat(name="x", size=10**6, type=FileType.FILE)

    async def stream(path):
        for n in range(1000):
            pulled.append(n)
            yield b"%PDF-1.4\n" if n == 0 else b"x" * 1000

    out, _ = await file_cmd([_spec("/x")], stream=stream, stat_fn=stat_fn)
    assert out == b"/x: application/pdf\n"
    assert len(pulled) == 2


@pytest.mark.asyncio
async def test_file_asks_a_ranged_read_for_the_header():
    asked: list[tuple[int, int]] = []

    async def stat_fn(path):
        return FileStat(name="x", size=10**6, type=FileType.FILE)

    async def stream(path):
        raise AssertionError("streamed")
        yield b""

    async def read_range(path, *, offset, size):
        asked.append((offset, size))
        return b"\x89PNG\r\n\x1a\n"

    out, _ = await file_cmd(
        [_spec("/x")], stream=stream, stat_fn=stat_fn, read_range=read_range
    )
    assert out == b"/x: image/png\n"
    assert asked == [(0, 512)]
