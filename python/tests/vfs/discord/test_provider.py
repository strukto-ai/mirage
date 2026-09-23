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

from mirage.core.discord.config import DiscordConfig
from mirage.types import VFSName
from mirage.vfs.discord.discord import DiscordVFS


@pytest.fixture
def config():
    return DiscordConfig(token="test-bot-token")


def test_vfs_init(config):
    vfs = DiscordVFS(config)
    assert vfs.caches_reads is True


def test_vfs_name(config):
    vfs = DiscordVFS(config)
    assert vfs.name == VFSName.DISCORD


def test_vfs_accessor(config):
    vfs = DiscordVFS(config)
    assert vfs.accessor is not None
    assert vfs.accessor.config is config
    assert vfs.index is not None


def test_vfs_commands(config):
    vfs = DiscordVFS(config)
    # 52 native (generic factory read set incl. find and sed + bespoke
    # grep/rg/head + md5sum/sha1sum/sha384sum/sha512sum); acting on
    # Discord moved to the discord CLI
    assert len(vfs._commands) == 52
