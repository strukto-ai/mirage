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

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from mirage.core.gdocs.api import DocsApi, DocsClient
from tests.e2e.gdrive_mock import FakeRenderApi
from tests.fixtures.google_api import parameter_drift

MANAGER = SimpleNamespace(config=SimpleNamespace(api_base=""))


@pytest.mark.parametrize("fake", [DocsClient, FakeRenderApi])
def test_each_implementation_takes_the_protocols_parameters(fake):
    assert parameter_drift(DocsApi, fake) == {}


@pytest.mark.asyncio
async def test_a_document_is_read_with_every_tab():
    doc = {"documentId": "abc123", "title": "Test Doc", "tabs": []}
    with patch(
        "mirage.core.gdocs.api.google_get",
        new_callable=AsyncMock,
        return_value=doc,
    ) as get:
        result = await DocsClient(MANAGER).read_doc("abc123")
    assert json.loads(result) == doc
    get.assert_awaited_once_with(
        MANAGER,
        "https://docs.googleapis.com/v1/documents/abc123",
        params={"includeTabsContent": "true"},
    )
