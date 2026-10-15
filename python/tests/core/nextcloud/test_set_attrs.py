from unittest.mock import AsyncMock, patch

import httpx
import pytest

from mirage.core.nextcloud.set_attrs import set_attrs
from mirage.types import PathSpec

FILE = "https://cloud.example.com/remote.php/dav/files/user/a.txt"
MTIME = "2020-01-01T00:00:01.900000+00:00"


@pytest.mark.parametrize(
    ("status", "residual"),
    [("200 OK", {"uid": 7}), ("403 Forbidden", {"uid": 7, "mtime": MTIME})],
)
@pytest.mark.asyncio
async def test_an_mtime_is_set_in_whole_seconds(make_acc, status, residual):
    body = (
        '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response>'
        "<d:href>/remote.php/dav/files/user/a.txt</d:href><d:propstat>"
        "<d:prop><d:lastmodified/></d:prop>"
        f"<d:status>HTTP/1.1 {status}</d:status>"
        "</d:propstat></d:response></d:multistatus>"
    )
    answer = httpx.Response(
        207, content=body.encode(), request=httpx.Request("PROPPATCH", FILE)
    )
    with patch(
        "mirage.core.nextcloud.set_attrs.dav_request",
        new_callable=AsyncMock,
        return_value=answer,
    ) as request:
        got = await set_attrs(
            make_acc(), PathSpec.from_str_path("/a.txt"), uid=7, mtime=MTIME
        )
    assert request.await_args.args[1:] == ("PROPPATCH", FILE)
    assert (
        b"<d:lastmodified>1577836801</d:lastmodified>"
        in (request.await_args.kwargs["content"])
    )
    assert got == residual
