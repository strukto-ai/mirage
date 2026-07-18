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

from mirage.resource.gmail.config import GmailConfig
from mirage.resource.gmail.gmail import GmailResource
from mirage.types import ResourceName


@pytest.fixture
def config():
    return GmailConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )


def test_resource_init(config):
    resource = GmailResource(config=config)
    assert resource.name == ResourceName.GMAIL
    assert resource.caches_reads is True


def test_resource_accessor(config):
    resource = GmailResource(config=config)
    assert resource.accessor is not None
    assert resource.accessor.config is config
    assert resource.accessor.token_manager is not None


def test_resource_commands_registered(config):
    resource = GmailResource(config=config)
    cmds = resource.commands()
    assert len(cmds) > 15
