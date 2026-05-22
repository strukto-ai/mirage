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

from mirage.resource.r2 import R2Config, R2Resource
from mirage.resource.s3 import S3Config
from mirage.resource.secrets import reveal_secret
from mirage.types import ResourceName


def test_r2config_defaults():
    config = R2Config(bucket="my-bucket", account_id="account-123")
    assert config.region == "auto"
    assert config.timeout == 30
    assert config.resolved_endpoint_url() == (
        "https://account-123.r2.cloudflarestorage.com")


def test_r2config_immutable():
    config = R2Config(bucket="my-bucket", account_id="account-123")
    with pytest.raises(ValidationError):
        config.bucket = "other-bucket"


def test_r2config_to_s3_config():
    config = R2Config(
        bucket="my-bucket",
        account_id="account-123",
        access_key_id="access-key",
        secret_access_key="secret-key",
        proxy="http://localhost:8080",
    )
    s3_config = config.to_s3_config()
    assert isinstance(s3_config, S3Config)
    assert s3_config.bucket == "my-bucket"
    assert s3_config.region == "auto"
    assert s3_config.endpoint_url == (
        "https://account-123.r2.cloudflarestorage.com")
    assert reveal_secret(s3_config.aws_access_key_id) == "access-key"
    assert reveal_secret(s3_config.aws_secret_access_key) == "secret-key"
    assert s3_config.proxy == "http://localhost:8080"


def test_r2config_custom_endpoint():
    config = R2Config(
        bucket="my-bucket",
        endpoint_url="https://custom.example.com",
    )
    assert config.resolved_endpoint_url() == "https://custom.example.com"


def test_r2config_requires_account_id_or_endpoint():
    config = R2Config(bucket="my-bucket")
    with pytest.raises(ValueError):
        config.resolved_endpoint_url()


def test_r2resource_uses_s3_resource_type():
    resource = R2Resource(
        R2Config(bucket="my-bucket", account_id="account-123"))
    assert resource.name == ResourceName.S3
    assert resource.is_remote is True
    assert isinstance(resource.config, S3Config)
    assert resource.config.endpoint_url == (
        "https://account-123.r2.cloudflarestorage.com")


def test_r2resource_preserves_original_config():
    config = R2Config(bucket="my-bucket", account_id="account-123")
    resource = R2Resource(config)
    assert resource.r2_config is config
