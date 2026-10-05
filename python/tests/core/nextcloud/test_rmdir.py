import errno

import pytest

from mirage.core.nextcloud.mkdir import mkdir
from mirage.core.nextcloud.rmdir import rmdir
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_rmdir_removes_an_empty_collection(make_acc):
    acc = make_acc({})
    await mkdir(acc, PathSpec.from_str_path("/dir"))
    await rmdir(acc, PathSpec.from_str_path("/dir"))
    assert "dir/" not in acc._fake.dirs


@pytest.mark.asyncio
async def test_rmdir_refuses_a_collection_holding_a_file(make_acc):
    acc = make_acc({"dir/a.txt": b"a", "keep.txt": b"k"})
    with pytest.raises(OSError) as excinfo:
        await rmdir(acc, PathSpec.from_str_path("/dir"))
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert acc._fake.files == {"dir/a.txt": b"a", "keep.txt": b"k"}


@pytest.mark.asyncio
async def test_rmdir_refuses_a_collection_holding_only_a_subtree(make_acc):
    acc = make_acc({"dir/sub/deep.txt": b"d"})
    with pytest.raises(OSError) as excinfo:
        await rmdir(acc, PathSpec.from_str_path("/dir"))
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert acc._fake.files == {"dir/sub/deep.txt": b"d"}


@pytest.mark.asyncio
async def test_mkdir_then_rmdir_of_a_nested_chain(make_acc):
    acc = make_acc({})
    await mkdir(acc, PathSpec.from_str_path("/a/b/c"), parents=True)
    await rmdir(acc, PathSpec.from_str_path("/a/b/c"))
    assert "a/b/c/" not in acc._fake.dirs
