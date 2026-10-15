import pytest

from mirage.core.nextcloud.capacity import capacity
from mirage.types import CapacityResult, CapacityState
from tests.core.nextcloud.conftest import ROOT, answering, multistatus


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
    body = multistatus(
        status,
        f"<d:quota-available-bytes>{available}</d:quota-available-bytes>"
        "<d:quota-used-bytes>300</d:quota-used-bytes>",
    )
    with answering("capacity", 207, body) as request:
        assert await capacity(make_acc()) == expected
    assert request.await_args.args[1:3] == ("PROPFIND", f"{ROOT}/")
