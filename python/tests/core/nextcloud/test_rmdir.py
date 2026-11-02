import errno
import re
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime, parsedate_to_datetime
from unittest.mock import AsyncMock, patch
from urllib.parse import quote

import httpx
import pytest

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.rmdir import ATTEMPTS, FENCE, rmdir
from mirage.types import PathSpec
from tests.core.nextcloud.conftest import ROOT, multistatus

HREF = "/remote.php/dav/files/user"


class FakeFolder:
    """One Nextcloud folder as rmdir sees it: its children, a modified
    time in whole seconds that every arrival moves to the server's
    clock, and ``If-Unmodified-Since`` honoured on DELETE."""

    def __init__(
        self,
        name: str,
        children: tuple[str, ...] = (),
        age: float = 60,
        exists: bool = True,
        settable: bool = True,
    ) -> None:
        self.name = name
        self.children = list(children)
        self.clock = datetime(2026, 11, 2, 12, 0, 0, tzinfo=timezone.utc)
        self.modified = (self.clock - timedelta(seconds=age)).replace(
            microsecond=0
        )
        self.exists = exists
        self.settable = settable
        self.locked = False
        self.busy = False
        self.calls: list[tuple[str, str, dict[str, str]]] = []
        self.before: dict[str, Callable[[], None]] = {}

    def arrive(self, child: str) -> None:
        self.children.append(child)
        self.modified = self.clock.replace(microsecond=0)

    def answer(self, status: int, body: bytes = b"") -> httpx.Response:
        return httpx.Response(
            status,
            content=body,
            headers={"Date": format_datetime(self.clock, True)},
            request=httpx.Request("GET", ROOT),
        )

    def listing(self) -> bytes:
        own = f"{HREF}/{quote(self.name)}/"
        stamp = format_datetime(self.modified, True)
        rows = [
            f"<d:response><d:href>{own}</d:href><d:propstat><d:prop>"
            f"<d:getlastmodified>{stamp}</d:getlastmodified></d:prop>"
            "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
        ]
        rows += [
            f"<d:response><d:href>{own}{quote(c)}</d:href></d:response>"
            for c in self.children
        ]
        return (
            '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">'
            + "".join(rows)
            + "</d:multistatus>"
        ).encode()

    async def __call__(
        self,
        accessor: NextcloudAccessor,
        method: str,
        url: str,
        headers: dict[str, str] | None = None,
        content: bytes | None = None,
    ) -> httpx.Response:
        self.calls.append((method, url, dict(headers or {})))
        self.clock += timedelta(milliseconds=300)
        if method in self.before:
            self.before.pop(method)()
        if not self.exists:
            return self.answer(404)
        if method == "PROPFIND":
            if self.busy:
                self.modified = self.clock.replace(microsecond=0)
            return self.answer(207, self.listing())
        if method == "PROPPATCH":
            if not self.settable:
                return self.answer(
                    207, multistatus("403 Forbidden", "<d:lastmodified/>")
                )
            seconds = re.search(rb"<d:lastmodified>(\d+)<", content or b"")
            assert seconds is not None
            self.modified = datetime.fromtimestamp(
                int(seconds.group(1)), timezone.utc
            )
            return self.answer(207, multistatus("200 OK", "<d:lastmodified/>"))
        if self.locked:
            return self.answer(423)
        since = parsedate_to_datetime(headers["If-Unmodified-Since"])
        if self.modified > since:
            return self.answer(412)
        self.exists = False
        return self.answer(204)


def removing(folder: FakeFolder):
    return patch("mirage.core.nextcloud.rmdir.dav_request", new=folder)


def methods(folder: FakeFolder) -> list[str]:
    return [method for method, _, _ in folder.calls]


@pytest.fixture
def waits():
    with patch(
        "mirage.core.nextcloud.rmdir.sleep", new_callable=AsyncMock
    ) as wait:
        yield wait


@pytest.mark.asyncio
async def test_rmdir_removes_an_empty_collection_in_two_requests(make_acc):
    folder = FakeFolder("dir")
    with removing(folder):
        await rmdir(make_acc(), PathSpec.from_str_path("/dir"))
    assert not folder.exists
    assert methods(folder) == ["PROPFIND", "DELETE"]
    method, url, headers = folder.calls[1]
    assert url == f"{ROOT}/dir/"
    assert parsedate_to_datetime(headers["If-Unmodified-Since"]) == (
        folder.modified
    )


@pytest.mark.asyncio
async def test_rmdir_refuses_a_collection_holding_a_child(make_acc):
    folder = FakeFolder("dir", children=("a.txt",))
    with removing(folder), pytest.raises(OSError) as excinfo:
        await rmdir(make_acc(), PathSpec.from_str_path("/dir"))
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert folder.exists and methods(folder) == ["PROPFIND"]


@pytest.mark.asyncio
async def test_a_child_created_after_the_check_survives(make_acc):
    folder = FakeFolder("dir")
    folder.before["DELETE"] = lambda: folder.arrive("late.txt")
    with removing(folder), pytest.raises(OSError) as excinfo:
        await rmdir(make_acc(), PathSpec.from_str_path("/dir"))
    assert excinfo.value.errno == errno.ENOTEMPTY
    assert folder.exists and folder.children == ["late.txt"]
    assert methods(folder) == ["PROPFIND", "DELETE", "PROPFIND"]


@pytest.mark.asyncio
async def test_a_child_that_came_and_went_is_checked_again(make_acc):
    folder = FakeFolder("dir")

    def churn() -> None:
        folder.arrive("tmp")
        folder.children.clear()

    folder.before["DELETE"] = churn
    with removing(folder):
        await rmdir(make_acc(), PathSpec.from_str_path("/dir"))
    assert not folder.exists
    assert methods(folder) == [
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
        await rmdir(make_acc(), PathSpec.from_str_path("/dir"))
    assert not folder.exists
    assert methods(folder) == ["PROPFIND", "PROPPATCH", "PROPFIND", "DELETE"]


@pytest.mark.asyncio
async def test_a_child_in_the_backdated_second_survives(make_acc):
    folder = FakeFolder("dir", age=0)
    folder.before["DELETE"] = lambda: folder.arrive("late.txt")
    with removing(folder), pytest.raises(OSError) as excinfo:
        await rmdir(make_acc(), PathSpec.from_str_path("/dir"))
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
        await rmdir(make_acc(), PathSpec.from_str_path("/dir"))
    assert not folder.exists
    waits.assert_awaited_once_with(FENCE.total_seconds())


@pytest.mark.asyncio
async def test_a_collection_that_keeps_changing_is_busy(make_acc, waits):
    folder = FakeFolder("dir", settable=False)
    folder.busy = True
    with removing(folder), pytest.raises(OSError) as excinfo:
        await rmdir(make_acc(), PathSpec.from_str_path("/dir"))
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
        await rmdir(make_acc(), PathSpec.from_str_path("/dir"))
    assert excinfo.value.errno == code


@pytest.mark.asyncio
async def test_a_percent_encoded_name_is_not_its_own_child(make_acc):
    folder = FakeFolder("a b#c")
    with removing(folder):
        await rmdir(make_acc(), PathSpec.from_str_path("/a b#c"))
    assert not folder.exists
    assert folder.calls[0][1] == f"{ROOT}/a%20b%23c/"
