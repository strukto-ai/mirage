"""Exercise the consumer loop with fake Dropbox notifications."""

import asyncio
import json
import runpy
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.types import Delta, PathSpec

EXAMPLE = runpy.run_path(
    str(
        Path(__file__).resolve().parents[4]
        / "examples/python/dropbox/watch.py"
    )
)


def checkpoint(cursor):
    return json.dumps({"dropbox": {"cursor": cursor, "seen": {"a": "old"}}})


@pytest.mark.asyncio
async def test_longpoll_uses_latest_cursor_and_honors_idle_backoff():
    states = [checkpoint("a"), checkpoint("b"), checkpoint("c")]
    hook = MagicMock()
    hook.pull = AsyncMock(side_effect=[Delta((), state) for state in states])
    calls = []

    async def poll(cursor):
        calls.append(("poll", cursor))
        if len(calls) == 1:
            return False, 5
        if cursor == "a":
            return True, 2
        if cursor == "b":
            return True, 0
        raise asyncio.CancelledError

    async def pause(seconds):
        calls.append(("pause", seconds))

    notify = AsyncMock()
    root = PathSpec.from_str_path("/dropbox", "")
    with pytest.raises(asyncio.CancelledError):
        await EXAMPLE["run_longpoll"](hook, root, notify, poll, pause)
    assert calls == [
        ("poll", "a"),
        ("pause", 5),
        ("poll", "a"),
        ("pause", 2),
        ("poll", "b"),
        ("poll", "c"),
    ]
    assert [call.args[1] for call in hook.pull.await_args_list] == [
        None,
        *states[:2],
    ]
    notify.assert_not_called()


@pytest.mark.asyncio
async def test_missing_root_retries_then_notifies_before_next_poll():
    state = checkpoint("recovered")
    missing = checkpoint("")
    change = MagicMock()
    hook = MagicMock()
    hook.pull = AsyncMock(
        side_effect=[Delta((), missing), Delta((change,), state)]
    )
    notify, pause = AsyncMock(), AsyncMock()
    poll = AsyncMock(side_effect=asyncio.CancelledError)
    with pytest.raises(asyncio.CancelledError):
        await EXAMPLE["run_longpoll"](
            hook, PathSpec.from_str_path("/dropbox", ""), notify, poll, pause
        )
    pause.assert_awaited_once_with(30)
    notify.assert_awaited_once_with(change)
    poll.assert_awaited_once_with("recovered")
    assert hook.pull.await_args_list[1].args[1] == missing


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,payload,expected",
    [
        (200, {"changes": False, "backoff": 7}, (False, 7)),
        (409, {"error": {".tag": "reset"}}, (True, 0)),
    ],
)
async def test_longpoll_http_contract(status, payload, expected):
    response = MagicMock(status=status)
    response.json = AsyncMock(return_value=payload)
    context = MagicMock()
    context.__aenter__ = AsyncMock(return_value=response)
    context.__aexit__ = AsyncMock(return_value=False)
    client = MagicMock()
    client.post.return_value = context
    assert await EXAMPLE["longpoll"](client, "cursor") == expected
    client.post.assert_called_once_with(
        EXAMPLE["LONGPOLL_URL"], json={"cursor": "cursor", "timeout": 30}
    )


def test_an_unknown_checkpoint_is_not_silently_ignored():
    with pytest.raises(ValueError, match="Expected"):
        EXAMPLE["cursor_of"]('{"_dbx": 1, "c": "cursor"}')
