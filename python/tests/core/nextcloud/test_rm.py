import pytest

from mirage.core.nextcloud.rm import rm_r
from mirage.types import PathSpec
from tests.core.nextcloud.conftest import FakeFolder, removing


@pytest.mark.asyncio
async def test_rm_r_takes_a_subtree_in_one_delete(make_acc):
    folder = FakeFolder("dir", children=("a.txt", "sub/"))
    with removing(folder):
        await rm_r(make_acc(), PathSpec.from_str_path("/dir"))
    assert not folder.exists
    assert folder.methods() == ["PROPFIND", "DELETE"]
    assert folder.calls[0][2]["Depth"] == "0"
