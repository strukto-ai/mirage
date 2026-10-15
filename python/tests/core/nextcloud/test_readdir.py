import pytest

from mirage.core.nextcloud.readdir import readdir
from mirage.types import FileType, PathSpec


@pytest.mark.asyncio
async def test_readdir_root_returns_children(make_acc):
    acc = make_acc({"hello.txt": b"x", "data/file.txt": b"y"})
    rows = await readdir(acc, PathSpec.from_str_path("/"))
    assert [(row.name, row.type) for row in rows] == [
        ("data", FileType.DIRECTORY),
        ("hello.txt", FileType.FILE),
    ]


@pytest.mark.asyncio
async def test_readdir_subdir(make_acc):
    acc = make_acc(
        {"data/a.txt": b"a", "data/sub/b.txt": b"b", "other.txt": b"o"}
    )
    rows = await readdir(acc, PathSpec.from_str_path("/data"))
    assert [row.name for row in rows] == ["a.txt", "sub"]


@pytest.mark.asyncio
async def test_readdir_file_raises_enotdir(make_acc):
    acc = make_acc({"data/a.txt": b"a"})
    with pytest.raises(NotADirectoryError):
        await readdir(acc, PathSpec.from_str_path("/data/a.txt"))


@pytest.mark.asyncio
async def test_readdir_rows_carry_size_and_type(make_acc):
    acc = make_acc({"f.txt": b"hello"})
    (row,) = await readdir(acc, PathSpec.from_str_path("/"))
    assert row.size == 5
    assert row.type is FileType.FILE


@pytest.mark.asyncio
async def test_readdir_rows_carry_remote_time_for_files(make_acc):
    acc = make_acc({"f.txt": b"hello"})
    (row,) = await readdir(acc, PathSpec.from_str_path("/"))
    assert row.modified == "2026-01-01T00:00:00+00:00"


@pytest.mark.asyncio
async def test_readdir_missing_path_is_enoent(make_acc):
    acc = make_acc({"data/a.txt": b"a"})
    with pytest.raises(FileNotFoundError):
        await readdir(acc, PathSpec.from_str_path("/never.txt"))


@pytest.mark.asyncio
async def test_readdir_missing_path_stats_each_component_once(make_acc):
    acc = make_acc({"data/a.txt": b"a"})
    fake = acc._fake
    asked: list[str] = []
    real_stat = fake.stat

    async def _counted(key):
        asked.append(key)
        return await real_stat(key)

    fake.stat = _counted
    with pytest.raises(FileNotFoundError):
        await readdir(acc, PathSpec.from_str_path("/data/never"))
    assert asked == ["data/never", "data"]


@pytest.mark.asyncio
async def test_readdir_missing_nested_path_is_enoent(make_acc):
    acc = make_acc({"data/a.txt": b"a"})
    with pytest.raises(FileNotFoundError):
        await readdir(acc, PathSpec.from_str_path("/nodir/deep"))


@pytest.mark.asyncio
async def test_readdir_below_a_file_is_enotdir(make_acc):
    acc = make_acc({"data/a.txt": b"a"})
    with pytest.raises(NotADirectoryError):
        await readdir(acc, PathSpec.from_str_path("/data/a.txt/x"))


@pytest.mark.asyncio
async def test_readdir_empty_directory_is_empty_not_missing(make_acc):
    # PROPFIND lists the collection itself, which is the only thing that
    # tells an empty directory apart from a path the server does not have.
    acc = make_acc({})
    await acc.operator().create_dir("empty/")
    entries = await readdir(acc, PathSpec.from_str_path("/empty"))
    assert entries == []
