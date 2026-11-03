import asyncio
import errno
from email.utils import parsedate_to_datetime

import httpx
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
async def test_a_child_that_came_and_went_is_surveyed_again(make_acc, waits):
    folder = FakeFolder("dir")
    waits.side_effect = folder.wait

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
        "PROPFIND",
        "DELETE",
    ]


@pytest.mark.parametrize("age", [0, 1])
@pytest.mark.asyncio
async def test_a_fresh_collection_is_waited_out_not_rewritten(
    make_acc, waits, age
):
    folder = FakeFolder("dir", age=age)
    original = folder.modified
    waits.side_effect = folder.wait
    with removing(folder):
        await remove(make_acc(), DIR, empty=True)
    assert not folder.exists
    assert folder.methods() == ["PROPFIND", "PROPFIND", "DELETE"]
    waits.assert_awaited_once_with(FENCE.total_seconds() - age)
    assert folder.modified == original


@pytest.mark.asyncio
async def test_two_removers_racing_a_write_keep_it(make_acc, waits):
    folder = FakeFolder("dir", age=0)

    async def wait(seconds: float) -> None:
        folder.wait(seconds)
        await asyncio.sleep(0)

    waits.side_effect = wait
    folder.before["DELETE"] = lambda: folder.arrive("late.txt")
    with removing(folder):
        outcomes = await asyncio.gather(
            remove(make_acc(), DIR, empty=True),
            remove(make_acc(), DIR, empty=True),
            return_exceptions=True,
        )
    assert [getattr(o, "errno", None) for o in outcomes] == [
        errno.ENOTEMPTY,
        errno.ENOTEMPTY,
    ]
    assert folder.exists and folder.children == ["late.txt"]
    assert folder.methods()[:2] == ["PROPFIND", "PROPFIND"]
    assert "PROPPATCH" not in folder.methods()


@pytest.mark.asyncio
async def test_a_future_dated_collection_is_backdated(make_acc):
    folder = FakeFolder("dir", age=-86400)
    with removing(folder):
        await remove(make_acc(), DIR, empty=True)
    assert not folder.exists
    assert folder.methods() == ["PROPFIND", "PROPPATCH", "PROPFIND", "DELETE"]


@pytest.mark.asyncio
async def test_a_failed_removal_puts_the_backdated_time_back(make_acc):
    folder = FakeFolder("dir", age=-86400)
    original = folder.modified
    folder.before["PROPPATCH"] = lambda: setattr(folder, "locked", True)
    with removing(folder), pytest.raises(OSError) as excinfo:
        await remove(make_acc(), DIR, empty=True)
    assert excinfo.value.errno == errno.EBUSY
    assert folder.exists and folder.modified == original
    assert folder.methods()[-1] == "PROPPATCH"


@pytest.mark.asyncio
async def test_a_failed_restore_keeps_the_removal_error(make_acc):
    folder = FakeFolder("dir", age=-86400)
    folder.before["PROPPATCH"] = lambda: setattr(folder, "locked", True)

    def drop() -> None:
        if folder.locked:
            raise httpx.ConnectError("dropped")

    folder.before["DELETE"] = lambda: folder.before.update(PROPPATCH=drop)
    with removing(folder), pytest.raises(OSError) as excinfo:
        await remove(make_acc(), DIR, empty=True)
    assert excinfo.value.errno == errno.EBUSY


@pytest.mark.asyncio
async def test_a_future_dated_collection_that_cannot_be_backdated_is_busy(
    make_acc,
):
    folder = FakeFolder("dir", age=-86400, settable=False)
    with removing(folder), pytest.raises(OSError) as excinfo:
        await remove(make_acc(), DIR, empty=True)
    assert excinfo.value.errno == errno.EBUSY
    assert folder.methods() == ["PROPFIND", "PROPPATCH"] * ATTEMPTS


@pytest.mark.parametrize("empty", [True, False])
@pytest.mark.asyncio
async def test_a_collection_that_keeps_changing_is_busy(
    make_acc, waits, empty
):
    folder = FakeFolder("dir")
    folder.busy = True
    with removing(folder), pytest.raises(OSError) as excinfo:
        await remove(make_acc(), DIR, empty=empty)
    assert excinfo.value.errno == errno.EBUSY
    assert folder.exists and waits.await_count == ATTEMPTS
    assert "DELETE" not in folder.methods()


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


@pytest.mark.parametrize(
    "dates",
    [{"getlastmodified": ""}, {"getlastmodified": "soon"}, {"Date": "soon"}],
)
@pytest.mark.asyncio
async def test_an_unreadable_date_is_eio_before_any_delete(make_acc, dates):
    folder = FakeFolder("dir")
    folder.dates = dates
    with removing(folder), pytest.raises(OSError) as excinfo:
        await remove(make_acc(), DIR, empty=True)
    assert excinfo.value.errno == errno.EIO
    assert folder.exists and folder.methods() == ["PROPFIND"]


@pytest.mark.parametrize(
    ("name", "url"),
    [("a b#c", f"{ROOT}/a%20b%23c/"), ("x/a b", f"{ROOT}/x/a%20b/")],
)
@pytest.mark.asyncio
async def test_an_encoded_or_nested_name_is_deleted_at_its_own_url(
    make_acc, name, url
):
    folder = FakeFolder(name)
    with removing(folder):
        await remove(
            make_acc(), PathSpec.from_str_path(f"/{name}"), empty=True
        )
    assert not folder.exists
    assert [u for _, u, _ in folder.calls] == [url, url]
