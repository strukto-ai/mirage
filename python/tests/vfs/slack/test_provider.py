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

from mirage.core.slack.config import SlackConfig
from mirage.types import VFSName
from mirage.vfs.slack.slack import SlackVFS


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test-token")


def test_vfs_init(config):
    vfs = SlackVFS(config)
    assert vfs.caches_reads is True


def test_vfs_name(config):
    vfs = SlackVFS(config)
    assert vfs.name == VFSName.SLACK


def test_vfs_accessor(config):
    vfs = SlackVFS(config)
    assert vfs.accessor is not None
    assert vfs.accessor.config is config


def test_vfs_commands_registered(config):
    vfs = SlackVFS(config)
    # 52 native (generic factory read set incl. find and sed + bespoke
    # grep/rg + md5sum/sha1sum/sha384sum/sha512sum); acting on Slack
    # moved to the slack CLI
    assert len(vfs._commands) == 52
