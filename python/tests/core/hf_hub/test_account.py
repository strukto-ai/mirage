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

from unittest.mock import patch

import pytest

from mirage.accessor.hf_hub import HfAccountAccessor
from mirage.core.hf_hub.account import whoami
from mirage.core.hf_hub.config import HfConfig


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.account.hub_get")
async def test_whoami_reads_the_v2_endpoint(mock_get):
    mock_get.return_value = {"name": "zoe"}
    account = HfAccountAccessor(HfConfig(token="t"))
    assert await whoami(account) == {"name": "zoe"}
    assert mock_get.await_args.args[1].endswith("/api/whoami-v2")
    assert mock_get.await_args.args[0] is account


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.account.hub_get")
async def test_whoami_of_a_non_object_is_empty(mock_get):
    mock_get.return_value = None
    assert await whoami(HfAccountAccessor(HfConfig())) == {}
