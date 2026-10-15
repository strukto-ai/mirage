import pytest

from mirage.core.nextcloud.set_attrs import set_attrs
from mirage.types import PathSpec
from tests.core.nextcloud.conftest import ROOT, answering, multistatus

MTIME = "2020-01-01T00:00:01.900000+00:00"


@pytest.mark.parametrize(
    ("status", "residual"),
    [("200 OK", {"uid": 7}), ("403 Forbidden", {"uid": 7, "mtime": MTIME})],
)
@pytest.mark.asyncio
async def test_an_mtime_is_set_in_whole_seconds(make_acc, status, residual):
    body = multistatus(status, "<d:lastmodified/>")
    with answering("set_attrs", 207, body) as request:
        got = await set_attrs(
            make_acc(), PathSpec.from_str_path("/a.txt"), uid=7, mtime=MTIME
        )
    assert request.await_args.args[1:] == ("PROPPATCH", f"{ROOT}/a.txt")
    assert (
        b"<d:lastmodified>1577836801</d:lastmodified>"
        in request.await_args.kwargs["content"]
    )
    assert got == residual
