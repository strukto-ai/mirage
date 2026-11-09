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
from aiohttp import web
from aiohttp.test_utils import TestServer

from mirage.accessor.notion import NotionAccessor
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.file_uploads import send_file_part


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name,on_wire",
    [("a b.txt", "a b.txt"), ('a"b\n.txt', "a%22b%0A.txt")],
)
async def test_a_rate_limited_part_goes_out_again_unchanged(name, on_wire):
    """A 429 on a part retries as every other Notion POST does, and the
    name arrives as fetch's FormData writes it."""
    seen = []

    async def send(request):
        form = await request.post()
        file = form["file"]
        seen.append(
            (
                file.filename,
                file.content_type,
                file.file.read(),
                form["part_number"],
            )
        )
        if len(seen) == 1:
            return web.json_response(
                {"message": "slow"},
                status=429,
                headers={"Retry-After": "0"},
            )
        return web.json_response({"id": "up-1"})

    app = web.Application()
    app.router.add_post("/v1/file_uploads/up-1/send", send)
    async with TestServer(app) as server:
        config = NotionConfig(
            api_key="k", base_url=str(server.make_url("/v1"))
        )
        async with NotionAccessor(config) as accessor:
            result = await send_file_part(
                accessor, "up-1", name, "text/plain", b"x\x00y", 3
            )

    assert result == {"id": "up-1"}
    assert seen == [(on_wire, "text/plain", b"x\x00y", "3")] * 2
