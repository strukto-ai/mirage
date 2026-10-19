from unittest.mock import AsyncMock

import pytest

from mirage.accessor.base import NOOPAccessor
from mirage.commands.builtin.errors import HttpTimeoutError
from mirage.commands.builtin.general.curl import curl
from mirage.commands.builtin.general.wget import wget
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.workspace import Workspace
from mirage.workspace.files import Files


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "argument,seconds", [("--timeout=0.25", 0.25), ("-T 0", None)]
)
async def test_wget_passes_timeout_and_classifies_failure(
    argument, seconds, monkeypatch
):
    request = AsyncMock(side_effect=HttpTimeoutError("example.test", 443, 250))
    monkeypatch.setitem(wget.__wrapped__.__globals__, "http_get", request)
    with Workspace({}) as ws:
        result = await ws.shell(
            f"wget {argument} -q -O - https://example.test/hello"
        )
        assert result.exit_code == 4
        assert not result.stderr
        assert request.call_args.kwargs["timeout"] == seconds


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", [None, FileNotFoundError("/format"), PermissionError("/format")]
)
@pytest.mark.parametrize(
    "silent,show_error", [(False, False), (True, False), (True, True)]
)
async def test_template_failure_refuses_transfer(
    failure, silent, show_error, monkeypatch
):
    request = AsyncMock()
    monkeypatch.setitem(curl.__wrapped__.__globals__, "http_request", request)
    dispatch = AsyncMock(side_effect=failure)
    vfs = Files(dispatch, ledger=False) if failure is not None else None
    ctx = Context(
        vfs=vfs,
        flags={
            "write_out": "@/format",
            "silent": silent,
            "show_error": show_error,
        },
    )
    with pytest.raises(UsageError) as caught:
        await curl(NOOPAccessor(), [], ["https://example.test/hello"], ctx)
    assert caught.value.exit_code == 26
    detail = "" if silent else "curl: Failed to open /format\n"
    assert str(caught.value) == (
        detail + "curl: option -w: error encountered when reading a file\n"
        "curl: try 'curl --help' or 'curl --manual' for more information"
    )
    request.assert_not_called()
