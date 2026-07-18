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

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexEntry, RAMIndexCacheStore
from mirage.commands.builtin.slack.ops import RESOLVE_GLOB as resolve_glob
from mirage.resource.slack.config import SlackConfig
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return SlackAccessor(config=SlackConfig(token="xoxb"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_resolve_glob_files_pdf(accessor, index):
    await index.set_dir("/channels/general__C001/2026-04-10/files", [
        ("a__F1.pdf",
         IndexEntry(id="F1",
                    name="a",
                    resource_type="slack/file",
                    vfs_name="a__F1.pdf",
                    extra={
                        "mimetype": "application/pdf",
                        "url_private_download": "u",
                        "channel_id": "C001",
                        "date": "2026-04-10"
                    })),
        ("b__F2.txt",
         IndexEntry(id="F2",
                    name="b",
                    resource_type="slack/file",
                    vfs_name="b__F2.txt",
                    extra={
                        "mimetype": "text/plain",
                        "url_private_download": "u",
                        "channel_id": "C001",
                        "date": "2026-04-10"
                    })),
    ])
    spec = PathSpec(
        resource_path=mount_key(
            "/channels/general__C001/2026-04-10/files/*.pdf", ""),
        virtual="/channels/general__C001/2026-04-10/files/*.pdf",
        directory="/channels/general__C001/2026-04-10/files/",
        pattern="*.pdf",
        resolved=False,
    )
    matched = await resolve_glob(accessor, [spec], index=index)
    assert len(matched) == 1
    assert matched[0].virtual.endswith("a__F1.pdf")
