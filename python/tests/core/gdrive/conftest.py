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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig
from tests.fixtures.gdrive_api import FakeDrive, install_drive


@pytest.fixture
def fake_drive(monkeypatch):
    fake = FakeDrive()
    install_drive(monkeypatch, fake)
    return fake


@pytest.fixture
def gdrive_config():
    return GoogleConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )


@pytest.fixture
def gdrive_accessor(gdrive_config):
    manager = TokenManager(gdrive_config)
    manager._access_token = "fake-token"
    manager._expires_at = 9999999999
    return GDriveAccessor(config=gdrive_config, token_manager=manager)


def _scoped_gdrive_accessor(folder_id: str) -> GDriveAccessor:
    config = GoogleConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
        folder_id=folder_id,
    )
    manager = TokenManager(config)
    manager._access_token = "fake-token"
    manager._expires_at = 9999999999
    return GDriveAccessor(config=config, token_manager=manager)


@pytest.fixture
def scoped_accessor():
    return _scoped_gdrive_accessor
