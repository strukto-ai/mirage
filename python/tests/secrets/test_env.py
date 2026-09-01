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

from mirage.secrets.config import EnvConfig
from mirage.secrets.env import fetch_env
from mirage.secrets.errors import SecretsError


@pytest.mark.asyncio
async def test_fetch_env_returns_the_process_env(monkeypatch):
    monkeypatch.setenv("MIRAGE_TEST_SECRET", "shh")
    secret = await fetch_env(EnvConfig(), "")
    assert secret.fields["MIRAGE_TEST_SECRET"] == "shh"
    assert secret.expires_at is None


@pytest.mark.asyncio
async def test_fetch_env_refuses_a_ref():
    with pytest.raises(SecretsError, match="sub-address"):
        await fetch_env(EnvConfig(), "prod")
