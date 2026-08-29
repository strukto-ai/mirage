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

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint.resolve import _drive_cache, _site_cache
from mirage.ops.sharepoint.identity import live_identity
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"


class _PoisonIndex:
    """An index cache that fails loudly if the op ever consults it."""

    def __getattr__(self, name):
        raise AssertionError(f"live_identity must not touch index.{name}")


def _accessor() -> SharePointAccessor:
    return SharePointAccessor(SharePointConfig(access_token="tok"))


def _ps(virtual: str) -> PathSpec:
    return PathSpec(resource_path=mount_key(virtual, "/sp"),
                    virtual=virtual,
                    directory=virtual)


@pytest.fixture(autouse=True)
def _reset_caches():
    _site_cache.clear()
    _drive_cache.clear()
    yield
    _site_cache.clear()
    _drive_cache.clear()


@pytest.mark.asyncio
async def test_live_identity_ignores_a_poisoned_index():
    _site_cache["Engineering"] = _SITE_ID
    _drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    url = f"{_BASE}/drives/{_DRIVE_ID}/root:/report.docx"
    with aioresponses() as m:
        m.get(url,
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
            _ps("/sp/Engineering/Documents/report.docx"),
            index=_PoisonIndex())
    assert result.exists is True
    assert result.fingerprint == "ctag-abc"
