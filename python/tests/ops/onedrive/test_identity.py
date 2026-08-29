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
from aioresponses import aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.ops.onedrive.identity import live_identity
from mirage.types import PathSpec

_FILE_URL = ("https://graph.microsoft.com/v1.0/me/drive"
             "/root:/Docs/report.docx")


class _PoisonIndex:
    """An index cache that fails loudly if the op ever consults it."""

    def __getattr__(self, name):
        raise AssertionError(f"live_identity must not touch index.{name}")


def _accessor(**kw) -> OneDriveAccessor:
    return OneDriveAccessor(OneDriveConfig(access_token="tok", **kw))


@pytest.mark.asyncio
async def test_live_identity_ignores_a_poisoned_index():
    with aioresponses() as m:
        m.get(_FILE_URL,
              payload={
                  "id": "01ITEM",
                  "name": "report.docx",
                  "cTag": "ctag-abc",
                  "file": {
                      "mimeType": "application/vnd.openxml"
                  },
              })
        result = await live_identity(
            _accessor(),
            PathSpec.from_str_path("/Docs/report.docx"),
            index=_PoisonIndex())
    assert result.exists is True
    assert result.fingerprint == "ctag-abc"
