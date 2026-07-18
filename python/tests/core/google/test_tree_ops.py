from unittest.mock import AsyncMock

import pytest

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.google.tree_ops import make_stat
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_stat_propagates_parent_refresh_failure():
    readdir = AsyncMock(side_effect=RuntimeError("google unavailable"))
    stat = make_stat(readdir)

    with pytest.raises(RuntimeError, match="google unavailable"):
        await stat(None, PathSpec.from_str_path("/owned/missing.json"),
                   RAMIndexCacheStore())
