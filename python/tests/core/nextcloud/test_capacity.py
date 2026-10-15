from unittest.mock import AsyncMock, patch

import httpx
import pytest

from mirage.core.nextcloud.capacity import capacity
from mirage.types import CapacityResult, CapacityState

ROOT = "https://cloud.example.com/remote.php/dav/files/user/"


@pytest.mark.parametrize(
    ("available", "status", "expected"),
    [
        (
            "700",
            "200 OK",
            CapacityResult(
                state=CapacityState.QUOTA, total=1000, used=300, available=700
            ),
        ),
        ("-3", "200 OK", CapacityResult(state=CapacityState.ELASTIC)),
        ("", "404 Not Found", CapacityResult(state=CapacityState.UNKNOWN)),
    ],
)
@pytest.mark.asyncio
async def test_the_quota_properties_are_the_capacity(
    make_acc, available, status, expected
):
    body = (
        '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response>'
        "<d:href>/remote.php/dav/files/user/</d:href><d:propstat><d:prop>"
        f"<d:quota-available-bytes>{available}</d:quota-available-bytes>"
        "<d:quota-used-bytes>300</d:quota-used-bytes>"
        f"</d:prop><d:status>HTTP/1.1 {status}</d:status></d:propstat>"
        "</d:response></d:multistatus>"
    )
    answer = httpx.Response(
        207, content=body.encode(), request=httpx.Request("PROPFIND", ROOT)
    )
    with patch(
        "mirage.core.nextcloud.capacity.dav_request",
        new_callable=AsyncMock,
        return_value=answer,
    ) as request:
        assert await capacity(make_acc()) == expected
    assert request.await_args.args[1:3] == ("PROPFIND", ROOT)
