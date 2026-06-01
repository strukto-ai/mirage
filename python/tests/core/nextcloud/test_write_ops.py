import pytest

from mirage.core.nextcloud.copy import copy
from mirage.core.nextcloud.create import create
from mirage.core.nextcloud.mkdir import mkdir
from mirage.core.nextcloud.rename import rename
from mirage.core.nextcloud.rm import rm_r
from mirage.core.nextcloud.truncate import truncate
from mirage.core.nextcloud.unlink import unlink
from mirage.core.nextcloud.write import write_bytes
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_write_bytes_uploads(make_acc):
    acc = make_acc({})
    await write_bytes(acc, PathSpec.from_str_path("/hello.txt"), b"hi there")
    assert acc._fake.files == {"hello.txt": b"hi there"}


@pytest.mark.asyncio
async def test_unlink_deletes_file(make_acc):
    acc = make_acc({"delete-me.txt": b"x"})
    await unlink(acc, PathSpec.from_str_path("/delete-me.txt"))
    assert "delete-me.txt" not in acc._fake.files


@pytest.mark.asyncio
async def test_create_writes_empty_file(make_acc):
    acc = make_acc({})
    await create(acc, PathSpec.from_str_path("/touched.txt"))
    assert acc._fake.files.get("touched.txt") == b""


@pytest.mark.asyncio
async def test_mkdir_creates_collection(make_acc):
    acc = make_acc({})
    await mkdir(acc, PathSpec.from_str_path("/newdir"))
    assert "newdir/" in acc._fake.dirs


@pytest.mark.asyncio
async def test_copy_duplicates_file(make_acc):
    acc = make_acc({"src.txt": b"payload"})
    await copy(acc, PathSpec.from_str_path("/src.txt"),
               PathSpec.from_str_path("/dst.txt"))
    assert acc._fake.files["dst.txt"] == b"payload"
    assert acc._fake.files["src.txt"] == b"payload"


@pytest.mark.asyncio
async def test_rename_moves_file(make_acc):
    acc = make_acc({"old.txt": b"data"})
    await rename(acc, PathSpec.from_str_path("/old.txt"),
                 PathSpec.from_str_path("/new.txt"))
    assert acc._fake.files.get("new.txt") == b"data"
    assert "old.txt" not in acc._fake.files


@pytest.mark.asyncio
async def test_rm_r_removes_subtree(make_acc):
    acc = make_acc({
        "dir/a.txt": b"a",
        "dir/sub/b.txt": b"b",
        "keep.txt": b"k"
    })
    await rm_r(acc, PathSpec.from_str_path("/dir"))
    assert "dir/a.txt" not in acc._fake.files
    assert "dir/sub/b.txt" not in acc._fake.files
    assert "keep.txt" in acc._fake.files


@pytest.mark.asyncio
async def test_truncate_pads_and_shrinks(make_acc):
    acc = make_acc({"f.txt": b"abcdef"})
    await truncate(acc, PathSpec.from_str_path("/f.txt"), 3)
    assert acc._fake.files["f.txt"] == b"abc"
    await truncate(acc, PathSpec.from_str_path("/f.txt"), 5)
    assert acc._fake.files["f.txt"] == b"abc\x00\x00"
