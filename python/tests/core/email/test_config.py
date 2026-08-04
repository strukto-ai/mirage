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
from pydantic import ValidationError

from mirage.accessor.email import EmailAccessor
from mirage.core.email.config import EmailConfig
from mirage.types import ResourceName


def test_email_resource_name_exists():
    assert ResourceName.EMAIL == "email"


def test_config_creation():
    config = EmailConfig(
        imap_host="imap.fastmail.com",
        smtp_host="smtp.fastmail.com",
        username="test@fastmail.com",
        password="test-password",
    )
    assert config.imap_host == "imap.fastmail.com"
    assert config.imap_port == 993
    assert config.smtp_port == 587
    assert config.use_ssl is True


def test_config_requires_credentials():
    with pytest.raises(ValidationError):
        EmailConfig()


def test_config_custom_ports():
    config = EmailConfig(
        imap_host="imap.example.com",
        imap_port=143,
        smtp_host="smtp.example.com",
        smtp_port=465,
        username="user",
        password="pass",
        use_ssl=False,
    )
    assert config.imap_port == 143
    assert config.smtp_port == 465
    assert config.use_ssl is False


def test_accessor_creation():
    config = EmailConfig(
        imap_host="imap.fastmail.com",
        smtp_host="smtp.fastmail.com",
        username="test@fastmail.com",
        password="test-password",
    )
    accessor = EmailAccessor(config)
    assert accessor.config is config
