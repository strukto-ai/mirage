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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.core.dropbox._client import (DROPBOX_API_BASE,
                                         DROPBOX_CONTENT_BASE,
                                         DropboxTokenManager, _token_url)
from mirage.resource.dropbox.config import DropboxConfig


def make_config(**overrides) -> DropboxConfig:
    return DropboxConfig(client_id="c",
                         client_secret="s",
                         refresh_token="r",
                         **overrides)


def test_default_bases_are_production_hosts():
    tm = DropboxTokenManager(make_config())
    assert tm.api_base == DROPBOX_API_BASE
    assert tm.content_base == DROPBOX_CONTENT_BASE


def test_endpoint_override_serves_api_and_content_from_one_origin():
    tm = DropboxTokenManager(make_config(endpoint="http://127.0.0.1:9999/"))
    assert tm.api_base == "http://127.0.0.1:9999/2"
    assert tm.content_base == "http://127.0.0.1:9999/2"
    assert _token_url(make_config(endpoint="http://127.0.0.1:9999/")) == \
        "http://127.0.0.1:9999/oauth2/token"


def test_token_url_defaults_to_production():
    assert _token_url(
        make_config()) == "https://api.dropboxapi.com/oauth2/token"


@pytest.mark.asyncio
async def test_get_token_caches_until_expiry():
    tm = DropboxTokenManager(make_config())
    with patch("mirage.core.dropbox._client.refresh_access_token",
               new_callable=AsyncMock,
               return_value=("tok", 14400)) as refresh:
        assert await tm.get_token() == "tok"
        assert await tm.get_token() == "tok"
    assert refresh.await_count == 1
