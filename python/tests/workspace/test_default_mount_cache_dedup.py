# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import pytest

from mirage.resource.ram import RAMResource
from mirage.workspace import Workspace


@pytest.mark.asyncio
async def test_cache_hit_does_not_double_store():
    ram = RAMResource()
    await ram.write("/big.bin", b"x" * 4096)
    ws = Workspace(resources={"/r": ram})
    try:
        await ws.execute("cat /r/big.bin > /dev/null")
        size_after_first = ws._cache.cache_size
        keys_first = sorted(ws._cache._entries.keys())

        await ws.execute("cat /r/big.bin > /dev/null")
        size_after_second = ws._cache.cache_size
        keys_second = sorted(ws._cache._entries.keys())

        assert size_after_second == size_after_first
        assert keys_second == keys_first
        assert all(k.startswith("/r/") for k in keys_second)
    finally:
        await ws.close()
