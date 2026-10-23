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

from mirage.core.gslides.api import SlidesApi, SlidesClient
from tests.e2e.gdrive_mock import FakeRenderApi
from tests.fixtures.google_api import parameter_drift

MANAGER = SimpleNamespace(config=SimpleNamespace(api_base=""))


@pytest.mark.parametrize("fake", [SlidesClient, FakeRenderApi])
def test_each_implementation_takes_the_protocols_parameters(fake):
    assert parameter_drift(SlidesApi, fake) == {}


@pytest.mark.asyncio
async def test_a_presentation_is_read_whole():
    with patch(
        "mirage.core.gslides.api.google_get",
        new_callable=AsyncMock,
        return_value={"presentationId": "p1"},
    ) as get:
        result = await SlidesClient(MANAGER).read_presentation("p1")
    assert json.loads(result) == {"presentationId": "p1"}
    get.assert_awaited_once_with(
        MANAGER, "https://slides.googleapis.com/v1/presentations/p1"
    )
