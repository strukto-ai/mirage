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

import asyncio
from typing import Any

import pytest
from pydantic import ValidationError

from mirage.accessor.chroma import ChromaAccessor
from mirage.vfs.chroma.config import ChromaConfig


def _opened(monkeypatch, config: ChromaConfig) -> dict[str, Any]:
    seen: dict[str, Any] = {}

    async def open_client(**kwargs: Any) -> str:
        seen.update(kwargs)
        return "client"

    monkeypatch.setattr(
        "mirage.accessor.chroma.chromadb.AsyncHttpClient", open_client
    )
    assert asyncio.run(ChromaAccessor(config).get_client()) == "client"
    return seen


def test_a_key_is_sent_in_the_chroma_token_header(monkeypatch):
    seen = _opened(
        monkeypatch, ChromaConfig(collection_name="docs", api_key="k-1")
    )
    assert seen["headers"] == {"x-chroma-token": "k-1"}


def test_no_key_sends_no_header(monkeypatch):
    seen = _opened(monkeypatch, ChromaConfig(collection_name="docs"))
    assert seen["headers"] is None


def test_the_environment_and_a_dotenv_reach_no_setting(monkeypatch, tmp_path):
    # chromadb's Settings() reads all four of these; one that names another
    # host makes its client refuse to open.
    monkeypatch.setenv("CHROMA_CLIENT_AUTH_CREDENTIALS", "from-env")
    monkeypatch.setenv(
        "CHROMA_CLIENT_AUTH_PROVIDER",
        "chromadb.auth.token_authn.TokenAuthClientProvider",
    )
    monkeypatch.setenv("CHROMA_SERVER_HOST", "env-host")
    (tmp_path / ".env").write_text("CHROMA_SERVER_HTTP_PORT=9999\n")
    monkeypatch.chdir(tmp_path)

    settings = _opened(monkeypatch, ChromaConfig(collection_name="docs"))[
        "settings"
    ]

    assert settings.chroma_client_auth_credentials is None
    assert settings.chroma_client_auth_provider is None
    assert settings.chroma_server_host is None
    assert settings.chroma_server_http_port is None


def test_an_empty_key_is_refused():
    with pytest.raises(ValidationError, match="api_key cannot be empty"):
        ChromaConfig(collection_name="docs", api_key=" ")
