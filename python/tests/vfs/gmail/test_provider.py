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

from mirage.types import VFSName
from mirage.vfs.gmail.config import GmailConfig
from mirage.vfs.gmail.gmail import GmailVFS


@pytest.fixture
def config():
    return GmailConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )


def test_vfs_init(config):
    vfs = GmailVFS(config=config)
    assert vfs.name == VFSName.GMAIL
    assert vfs.caches_reads is True


def test_vfs_accessor(config):
    vfs = GmailVFS(config=config)
    assert vfs.accessor is not None
    assert vfs.accessor.config is config
    assert vfs.accessor.token_manager is not None


def test_vfs_commands_registered(config):
    vfs = GmailVFS(config=config)
    cmds = vfs.commands()
    assert len(cmds) > 15
