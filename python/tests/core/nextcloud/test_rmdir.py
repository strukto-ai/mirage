import errno

import pytest

from mirage.core.nextcloud.rmdir import rmdir
from mirage.types import PathSpec
from tests.core.nextcloud.conftest import FakeFolder, removing


@pytest.mark.asyncio
async def test_rmdir_lists_the_children_and_refuses_one(make_acc):
    folder = FakeFolder("dir", children=("a.txt",))
    with removing(folder), pytest.raises(OSError) as excinfo:
        await rmdir(make_acc(), PathSpec.from_str_path("/dir"))
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert folder.exists and folder.calls[0][2]["Depth"] == "1"


@pytest.mark.asyncio
async def test_rmdir_removes_an_empty_collection(make_acc):
    folder = FakeFolder("dir")
    with removing(folder):
        await rmdir(make_acc(), PathSpec.from_str_path("/dir"))
    assert not folder.exists
