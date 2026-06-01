import pytest

from mirage.commands.builtin.generic.file import file_cmd
from mirage.types import FileStat, FileType, PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(original=path, directory=path)


def _make_backend(files: dict[str, tuple[bytes, FileType]], dirs: set[str]):

    async def stat_fn(accessor: object, p: PathSpec) -> FileStat:
        if p.original in dirs:
            return FileStat(name=p.original, type=FileType.DIRECTORY, size=0)
        if p.original in files:
            data, ftype = files[p.original]
            return FileStat(name=p.original, type=ftype, size=len(data))
        raise FileNotFoundError(p.original)

    async def read_bytes(accessor: object, p: PathSpec) -> bytes:
        return files[p.original][0]

    return stat_fn, read_bytes


@pytest.mark.asyncio
async def test_file_single_text():
    stat_fn, read_bytes = _make_backend(
        {"/a.txt": (b"hello world\n", FileType.TEXT)}, set())
    out, io = await file_cmd([_spec("/a.txt")],
                             read_bytes=read_bytes,
                             stat_fn=stat_fn)
    assert out == b"/a.txt: text"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_file_multiple_paths_one_line_each():
    stat_fn, read_bytes = _make_backend(
        {
            "/a.txt": (b"hello\n", FileType.TEXT),
            "/b.json": (b'{"k": 1}\n', FileType.JSON),
        }, set())
    out, _io = await file_cmd(
        [_spec("/a.txt"), _spec("/b.json")],
        read_bytes=read_bytes,
        stat_fn=stat_fn)
    lines = out.decode().splitlines()
    assert lines == ["/a.txt: text", "/b.json: json"]


@pytest.mark.asyncio
async def test_file_directory_reported_without_read():
    stat_fn, read_bytes = _make_backend({}, {"/d"})
    out, _io = await file_cmd([_spec("/d")],
                              read_bytes=read_bytes,
                              stat_fn=stat_fn)
    assert out == b"/d: directory"


@pytest.mark.asyncio
async def test_file_brief_drops_path_prefix():
    stat_fn, read_bytes = _make_backend(
        {"/a.txt": (b"hello\n", FileType.TEXT)}, set())
    out, _io = await file_cmd([_spec("/a.txt")],
                              read_bytes=read_bytes,
                              stat_fn=stat_fn,
                              b=True)
    assert out == b"text"


@pytest.mark.asyncio
async def test_file_missing_operand_raises():
    stat_fn, read_bytes = _make_backend({}, set())
    with pytest.raises(ValueError):
        await file_cmd([], read_bytes=read_bytes, stat_fn=stat_fn)
