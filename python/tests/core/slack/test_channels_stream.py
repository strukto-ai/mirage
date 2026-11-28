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

from mirage.core.slack.channels import list_channels_stream
from tests.fixtures.slack_workspace import LISTING


@pytest.mark.asyncio
async def test_list_channels_stream_yields_pages(slack_workspace):
    types = "public_channel,private_channel"
    await slack_workspace.first_page(LISTING, 1, types=types)
    seen = [
        page async for page in list_channels_stream(slack_workspace.accessor())
    ]
    assert [[ch["id"] for ch in page] for page in seen] == [["C1"], ["C2"]]
    first, second = await slack_workspace.run.params("GET", LISTING)
    assert (first["types"], first["exclude_archived"], first["limit"]) == (
        types,
        "true",
        "200",
    )
    assert second["cursor"] != ""
