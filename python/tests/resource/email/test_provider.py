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

from mirage.resource.email.config import EmailConfig
from mirage.resource.email.email import EmailResource
from mirage.types import ResourceName


@pytest.fixture
def config():
    return EmailConfig(
        imap_host="imap.test.com",
        smtp_host="smtp.test.com",
        username="user@test.com",
        password="pass",
    )


def test_resource_init(config):
    resource = EmailResource(config=config)
    assert resource.name == ResourceName.EMAIL
    assert resource.caches_reads is True


def test_resource_accessor(config):
    resource = EmailResource(config=config)
    assert resource.accessor is not None
    assert resource.accessor.config is config


def test_resource_commands_registered(config):
    resource = EmailResource(config=config)
    cmds = resource.commands()
    assert len(cmds) >= 6


def test_resource_ops_registered(config):
    resource = EmailResource(config=config)
    ops = resource.ops_list()
    assert len(ops) == 3
