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

from .conftest import make_s3_ws, patch_async_session


@pytest.mark.asyncio
async def test_s3_rm_after_cat_hits_backend_and_evicts_cache():
    objects = {"file.txt": b"hello\n"}
    with patch_async_session(objects):
        ws = make_s3_ws(objects)
        first = await ws.execute("cat /data/file.txt")
        assert (await first.stdout_str()) == "hello\n"

        removed = await ws.execute("rm /data/file.txt")
        assert removed.exit_code == 0
        assert "file.txt" not in objects

        reread = await ws.execute("cat /data/file.txt")
        assert reread.exit_code != 0
