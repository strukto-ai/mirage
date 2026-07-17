import asyncio

import pytest

from mirage.bridge.sync import run_async_from_sync


async def value() -> int:
    return 7


async def fail_with_runtime_error() -> int:
    raise RuntimeError("operation failed")


def test_run_async_from_sync_without_running_loop():
    assert run_async_from_sync(value()) == 7


@pytest.mark.asyncio
async def test_run_async_from_sync_inside_running_loop():
    assert run_async_from_sync(value()) == 7


@pytest.mark.asyncio
async def test_run_async_from_sync_with_current_loop_does_not_deadlock():
    assert run_async_from_sync(value(), asyncio.get_running_loop()) == 7


@pytest.mark.asyncio
async def test_runtime_error_from_operation_propagates_unchanged():
    with pytest.raises(RuntimeError, match="operation failed"):
        run_async_from_sync(fail_with_runtime_error())
