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

from mirage.core.google._client import refresh_access_token
from mirage.core.google.config import GoogleConfig
from mirage.resource.gdocs.config import GDocsConfig
from mirage.resource.gdrive.config import GoogleDriveConfig
from mirage.resource.secrets import reveal_secret


def test_google_config_creation():
    config = GoogleConfig(
        client_id="id",
        client_secret="secret",
        refresh_token="token",
    )
    assert config.client_id == "id"
    assert reveal_secret(config.client_secret) == "secret"
    assert reveal_secret(config.refresh_token) == "token"


def test_google_config_omits_client_secret_for_pkce():
    # Browser PKCE flows construct GoogleConfig without a secret.
    config = GoogleConfig(client_id="id", refresh_token="token")
    assert config.client_id == "id"
    assert config.client_secret is None
    assert reveal_secret(config.refresh_token) == "token"


@pytest.mark.asyncio
async def test_refresh_access_token_omits_client_secret_when_absent():
    # PKCE clients refresh with just (client_id, refresh_token, grant_type).
    # Sending an empty/None client_secret would be rejected by Google's
    # token endpoint for public clients, so make sure we don't include it.
    captured: dict = {}

    class _FakeResp:

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def raise_for_status(self):
            return None

        async def json(self):
            return {"access_token": "atk", "expires_in": 3600}

    class _FakeSession:

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def post(self, url, data):
            captured["url"] = url
            captured["data"] = data
            return _FakeResp()

    with patch("mirage.core.google._client.aiohttp.ClientSession",
               return_value=_FakeSession()):
        config = GoogleConfig(client_id="id", refresh_token="rt")
        token, expires = await refresh_access_token(config)
    assert token == "atk"
    assert expires == 3600
    assert "client_secret" not in captured["data"]
    assert captured["data"]["client_id"] == "id"
    assert captured["data"]["refresh_token"] == "rt"


@pytest.mark.asyncio
async def test_refresh_access_token_includes_client_secret_when_present():
    # Backwards compat: Node-style configs with a real secret keep working.
    captured: dict = {}

    class _FakeResp:

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def raise_for_status(self):
            return None

        async def json(self):
            return {"access_token": "atk", "expires_in": 3600}

    class _FakeSession:

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def post(self, url, data):
            captured["data"] = data
            return _FakeResp()

    with patch("mirage.core.google._client.aiohttp.ClientSession",
               return_value=_FakeSession()):
        config = GoogleConfig(
            client_id="id",
            client_secret="secret",
            refresh_token="rt",
        )
        await refresh_access_token(config)
    assert captured["data"]["client_secret"] == "secret"


def test_google_config_inherited_by_docs():
    config = GDocsConfig(
        client_id="id",
        client_secret="secret",
        refresh_token="token",
    )
    assert isinstance(config, GoogleConfig)
    assert config.client_id == "id"


def test_google_config_inherited_by_drive():
    config = GoogleDriveConfig(
        client_id="id",
        client_secret="secret",
        refresh_token="token",
    )
    assert isinstance(config, GoogleConfig)
    assert config.client_id == "id"
