import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.io import IOResult
from mirage.server.io_serde import (
    CallArgsError,
    answered,
    checked,
    io_result_to_dict,
)
from mirage.server.vfs_calls import VFS_CALL_BY_NAME
from mirage.types import Refusal
from mirage.workspace.workspace import Session


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
    io = IOResult(
        exit_code=126,
        stderr=b"rm: Permission denied\n",
        refusal=Refusal(kind="pending", reason="sign-off", ask_id="abc123"),
    )
    body = await io_result_to_dict(io)
    assert body["refusal"] == {
        "kind": "pending",
        "reason": "sign-off",
        "policy": "",
        "scope": "command",
        "ask_id": "abc123",
    }


@pytest.mark.asyncio
async def test_a_vfs_call_runs_or_explains_as_json():
    session = Session(Workspace({"/": RAMVFS()}, mode=MountMode.WRITE), None)
    write, read = VFS_CALL_BY_NAME["write"], VFS_CALL_BY_NAME["read"]
    args = checked(write, {"path": "/a", "data_base64": "aGk="})
    assert args == {"path": "/a", "data": b"hi"}
    assert await answered(session, write, args, False) == {}
    said = await answered(session, read, {"path": "/a"}, False)
    assert said == {"data_base64": "aGk="}
    unlink = VFS_CALL_BY_NAME["unlink"]
    explained = await answered(session, unlink, {"path": "/a"}, True)
    assert (explained["call"], explained["outcome"]) == ("unlink", "allow")
    assert await session.vfs.exists("/a")


def test_arguments_outside_the_schema_are_refused():
    write = VFS_CALL_BY_NAME["write"]
    with pytest.raises(CallArgsError, match="data_base64 must be base64"):
        checked(write, {"path": "/a", "data_base64": "%%"})
    with pytest.raises(CallArgsError, match="invalid arguments for vfs/write"):
        checked(write, {"path": "/a"})
