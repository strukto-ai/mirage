import errno
from email.utils import parsedate_to_datetime

import pytest

from mirage.core.nextcloud.fence import ATTEMPTS, FENCE, remove
from mirage.types import PathSpec
from tests.core.nextcloud.conftest import ROOT, FakeFolder, removing

DIR = PathSpec.from_str_path("/dir")


@pytest.mark.parametrize("empty", [True, False])
@pytest.mark.asyncio
async def test_an_old_collection_goes_in_two_requests(make_acc, empty):
    folder = FakeFolder("dir")
    with removing(folder):
        await remove(make_acc(), DIR, empty=empty)
    assert not folder.exists
    assert folder.methods() == ["PROPFIND", "DELETE"]
    _, url, headers = folder.calls[1]
    assert url == f"{ROOT}/dir/"
    assert parsedate_to_datetime(headers["If-Unmodified-Since"]) == (
        folder.modified
    )


@pytest.mark.asyncio
async def test_a_child_refuses_an_empty_only_removal(make_acc):
    folder = FakeFolder("dir", children=("a.txt",))
    with removing(folder), pytest.raises(OSError) as excinfo:
        await remove(make_acc(), DIR, empty=True)
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert folder.exists and folder.methods() == ["PROPFIND"]


@pytest.mark.asyncio
async def test_a_child_created_after_the_survey_survives(make_acc):
    folder = FakeFolder("dir")
    folder.before["DELETE"] = lambda: folder.arrive("late.txt")
    with removing(folder), pytest.raises(OSError) as excinfo:
        await remove(make_acc(), DIR, empty=True)
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert folder.exists and folder.children == ["late.txt"]
    assert folder.methods() == ["PROPFIND", "DELETE", "PROPFIND"]


@pytest.mark.asyncio
async def test_a_subtree_keeps_what_changed_after_the_survey(make_acc):
    folder = FakeFolder("dir", children=("a.txt",))
    folder.before["DELETE"] = lambda: folder.arrive("late.txt")
    with removing(folder), pytest.raises(OSError) as excinfo:
        await remove(make_acc(), DIR, empty=False)
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert folder.exists and folder.children == ["a.txt", "late.txt"]
    assert folder.methods() == ["PROPFIND", "DELETE"]


@pytest.mark.asyncio
async def test_a_child_that_came_and_went_is_surveyed_again(make_acc):
    folder = FakeFolder("dir")

    def churn() -> None:
        folder.arrive("tmp")
        folder.children.clear()

    folder.before["DELETE"] = churn
    with removing(folder):
        await remove(make_acc(), DIR, empty=True)
    assert not folder.exists
    assert folder.methods() == [
        "PROPFIND",
        "DELETE",
        "PROPFIND",
        "PROPPATCH",
        "PROPFIND",
        "DELETE",
    ]


@pytest.mark.parametrize("age", [0, 1, -86400])
@pytest.mark.asyncio
async def test_a_fresh_or_future_collection_is_backdated(make_acc, age):
    folder = FakeFolder("dir", age=age)
    with removing(folder):
        await remove(make_acc(), DIR, empty=True)
    assert not folder.exists
    assert folder.methods() == ["PROPFIND", "PROPPATCH", "PROPFIND", "DELETE"]


@pytest.mark.asyncio
async def test_a_child_in_the_backdated_second_survives(make_acc):
    folder = FakeFolder("dir", age=0)
    folder.before["DELETE"] = lambda: folder.arrive("late.txt")
    with removing(folder), pytest.raises(OSError) as excinfo:
        await remove(make_acc(), DIR, empty=True)
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert folder.exists and folder.children == ["late.txt"]


@pytest.mark.asyncio
async def test_a_fresh_collection_that_cannot_be_backdated_is_waited_out(
    make_acc, waits
):
    folder = FakeFolder("dir", age=0, settable=False)
    folder.before["PROPPATCH"] = lambda: setattr(
        folder, "clock", folder.clock + FENCE
    )
    with removing(folder):
        await remove(make_acc(), DIR, empty=True)
    assert not folder.exists
    waits.assert_awaited_once_with(FENCE.total_seconds())


@pytest.mark.parametrize("empty", [True, False])
@pytest.mark.asyncio
async def test_a_collection_that_keeps_changing_is_busy(
    make_acc, waits, empty
):
    folder = FakeFolder("dir", settable=False)
    folder.busy = True
    with removing(folder), pytest.raises(OSError) as excinfo:
        await remove(make_acc(), DIR, empty=empty)
    assert excinfo.value.errno == errno.EBUSY
    assert folder.exists and waits.await_count == ATTEMPTS


@pytest.mark.parametrize(
    ("setup", "code"),
    [
        ({"exists": False}, errno.ENOENT),
        ({"locked": True}, errno.EBUSY),
    ],
)
@pytest.mark.asyncio
async def test_the_server_refusal_maps_to_an_errno(make_acc, setup, code):
    folder = FakeFolder("dir")
    for key, value in setup.items():
        setattr(folder, key, value)
    with removing(folder), pytest.raises(OSError) as excinfo:
        await remove(make_acc(), DIR, empty=True)
    assert excinfo.value.errno == code


@pytest.mark.asyncio
async def test_a_percent_encoded_name_is_not_its_own_child(make_acc):
    folder = FakeFolder("a b#c")
    with removing(folder):
        await remove(make_acc(), PathSpec.from_str_path("/a b#c"), empty=True)
    assert not folder.exists
    assert folder.calls[0][1] == f"{ROOT}/a%20b%23c/"
