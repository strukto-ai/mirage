import pytest

from mirage.io import IOResult
from mirage.server.io_serde import io_result_to_dict
from mirage.types import Refusal


@pytest.mark.asyncio
async def test_a_plain_result_carries_no_refusal():
    body = await io_result_to_dict(IOResult(stdout=b"hi\n"))
    assert body == {
        "kind": "io",
        "exit_code": 0,
        "stdout": "hi\n",
        "stderr": "",
        "refusal": None,
    }


@pytest.mark.asyncio
async def test_a_refused_result_carries_the_record():
    io = IOResult(exit_code=126,
                  stderr=b"rm: Permission denied\n",
                  refusal=Refusal(kind="pending",
                                  reason="sign-off",
                                  ask_id="abc123"))
    body = await io_result_to_dict(io)
    assert body["refusal"] == {
        "kind": "pending",
        "reason": "sign-off",
        "policy": "",
        "scope": "command",
        "ask_id": "abc123",
    }
