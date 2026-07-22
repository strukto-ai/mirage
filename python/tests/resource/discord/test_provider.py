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

from mirage.resource.discord.config import DiscordConfig
from mirage.resource.discord.discord import DiscordResource
from mirage.types import ResourceName


@pytest.fixture
def config():
    return DiscordConfig(token="test-bot-token")


def test_resource_init(config):
    resource = DiscordResource(config)
    assert resource.caches_reads is True


def test_resource_name(config):
    resource = DiscordResource(config)
    assert resource.name == ResourceName.DISCORD


def test_resource_accessor(config):
    resource = DiscordResource(config)
    assert resource.accessor is not None
    assert resource.accessor.config is config
    assert resource.index is not None


def test_resource_commands(config):
    resource = DiscordResource(config)
    # 54 native (generic factory read set incl. find and sed + bespoke
    # grep/rg/head + discord_* writers + md5sum/sha1sum/sha384sum/sha512sum)
    # + 9 filetype cmds x 7 columnar exts
    assert len(resource._commands) == 54 + 9 * 7
