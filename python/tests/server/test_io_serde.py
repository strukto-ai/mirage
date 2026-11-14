import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.io import IOResult
from mirage.policy import Policy, Route, RouteContext
from mirage.runtime.python.monty import MontyRuntime
from mirage.server.io_serde import (
    CallArgsError,
    answered,
    body_of,
    checked,
    explanation_to_dict,
    io_result_to_dict,
)
from mirage.server.vfs_calls import VFS_CALL_BY_NAME
from mirage.types import PolicyDecision
from mirage.workspace.workspace import Session


@pytest.mark.asyncio
async def test_a_plain_result_carries_no_decision():
    body = await io_result_to_dict(IOResult(stdout=b"hi\n"))
    assert body == {
        "exit_code": 0,
        "stdout": "hi\n",
        "stderr": "",
        "decision": None,
    }


@pytest.mark.asyncio
async def test_a_refused_result_carries_the_record():
    io = IOResult(
        exit_code=126,
        stderr=b"rm: Permission denied\n",
        decision=PolicyDecision(
            kind="pending", reason="sign-off", ask_id="abc123"
        ),
    )
    body = await io_result_to_dict(io)
    assert body["decision"] == {
        "kind": "pending",
        "reason": "sign-off",
        "policy": "",
        "ask_id": "abc123",
    }


@pytest.mark.asyncio
async def test_a_vfs_call_runs_or_explains_as_json():
    session = Session(Workspace({"/": RAMVFS()}, mode=MountMode.WRITE), None)
    write, read = VFS_CALL_BY_NAME["write"], VFS_CALL_BY_NAME["read"]
    args = checked(write, {"path": "/a", "data": "aGk="})
    assert args == {"path": "/a", "data": b"hi"}
    assert await answered(session, write, args, False) is None
    said = await answered(session, read, {"path": "/a"}, False)
    assert said == "aGk="
    unlink = VFS_CALL_BY_NAME["unlink"]
    explained = await answered(session, unlink, {"path": "/a"}, True)
    assert (explained["call"], explained["outcome"]) == ("unlink", "allow")
    assert await session.vfs.exists("/a")


@pytest.mark.asyncio
async def test_a_stat_reports_its_times_as_rfc3339():
    session = Session(Workspace({"/": RAMVFS()}, mode=MountMode.WRITE), None)
    write, setattr_ = VFS_CALL_BY_NAME["write"], VFS_CALL_BY_NAME["setattr"]
    await answered(
        session, write, checked(write, {"path": "/a", "data": "aGk="}), False
    )
    mtime = {"path": "/a", "mtime": "2026-11-11T15:24:14.0629+08:00"}
    await answered(session, setattr_, checked(setattr_, mtime), False)
    said = await answered(
        session, VFS_CALL_BY_NAME["stat"], {"path": "/a"}, False
    )
    assert said["modified"] == "2026-11-11T07:24:14.062Z"


class _OnMonty(Policy):
    async def pre_execute(self, ctx: RouteContext) -> Route:
        return Route("monty", "plain arithmetic")


@pytest.mark.asyncio
async def test_an_explained_route_carries_its_reason():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines=[MontyRuntime()],
        policies=[_OnMonty()],
    )
    try:
        said = explanation_to_dict(await ws.explain("python3 -c 'print(1)'"))
    finally:
        await ws.close()
    assert said["answers"] == [
        {
            "kind": "route",
            "machine": "monty",
            "reason": "plain arithmetic",
            "policy": "_OnMonty",
        }
    ]


def test_arguments_outside_the_schema_are_refused():
    write = VFS_CALL_BY_NAME["write"]
    with pytest.raises(CallArgsError, match="data must be base64"):
        checked(write, {"path": "/a", "data": "%%"})
    with pytest.raises(CallArgsError, match="data is required") as missing:
        checked(write, {"path": "/a", "extra": 1})
    assert missing.value.error().record() == {
        "code": "missing_field",
        "message": "data is required",
        "param": "data",
    }
    with pytest.raises(CallArgsError) as unknown:
        checked(write, {"path": "/a", "data": "", "extra": 1})
    assert unknown.value.error().record() == {
        "code": "unknown_field",
        "message": "extra is not a known field",
        "param": "extra",
    }
    with pytest.raises(CallArgsError) as wrong:
        checked(write, {"path": 1, "data": ""})
    assert wrong.value.error().record() == {
        "code": "invalid_value",
        "message": "arguments do not fit vfs/write's schema",
        "param": "path",
    }


def test_a_call_answers_one_object():
    calls = VFS_CALL_BY_NAME
    assert body_of(calls["write"], None) == {}
    assert body_of(calls["list_files"], ["a"]) == {"items": ["a"]}
    assert body_of(calls["stat"], {"name": "a"}) == {"entry": {"name": "a"}}
    assert body_of(calls["exists"], False) == {"exists": False}
    assert body_of(None, "/a") == {"value": "/a"}
    assert body_of(calls["write"], {"outcome": "allow"}, explain=True) == {
        "explanation": {"outcome": "allow"}
    }
