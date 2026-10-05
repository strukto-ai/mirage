from unittest.mock import AsyncMock

import pytest

from mirage.commands.builtin.generic.crossmount.relay.relay import run_relay


@pytest.mark.asyncio
async def test_relay_rejects_wrong_strategy_before_dispatch():
    dispatch = AsyncMock()
    run_single = AsyncMock()
    with pytest.raises(
        ValueError, match="Unsupported cross-mount relay command: cat"
    ):
        await run_relay("cat", [], [], {}, dispatch, run_single)
    dispatch.assert_not_called()
    run_single.assert_not_called()
