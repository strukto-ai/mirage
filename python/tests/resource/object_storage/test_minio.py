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

from mirage.resource.minio import MinIOConfig, MinIOResource
from mirage.resource.s3 import S3Config
from mirage.resource.secrets import reveal_secret
from mirage.types import ResourceName


def test_minio_config_defaults():
    config = MinIOConfig(
        bucket="my-bucket",
        endpoint_url="http://localhost:9000",
        access_key_id="minioadmin",
        secret_access_key="minioadmin",
    )
    assert config.region == "us-east-1"
    assert config.path_style is True
    assert config.timeout == 30


def test_minio_config_immutable():
    config = MinIOConfig(
        bucket="my-bucket",
        endpoint_url="http://localhost:9000",
        access_key_id="k",
        secret_access_key="s",
    )
    with pytest.raises(ValidationError):
        config.bucket = "other"


def test_minio_config_to_s3_config():
    config = MinIOConfig(
        bucket="my-bucket",
        endpoint_url="http://localhost:9000",
        access_key_id="minioadmin",
        secret_access_key="minioadmin",
        proxy="http://localhost:8080",
    )
    s3 = config.to_s3_config()
    assert isinstance(s3, S3Config)
    assert s3.bucket == "my-bucket"
    assert s3.endpoint_url == "http://localhost:9000"
    assert s3.path_style is True
    assert reveal_secret(s3.aws_access_key_id) == "minioadmin"
    assert reveal_secret(s3.aws_secret_access_key) == "minioadmin"
    assert s3.proxy == "http://localhost:8080"


def test_minio_config_path_style_override():
    config = MinIOConfig(
        bucket="my-bucket",
        endpoint_url="https://minio.example.com",
        access_key_id="k",
        secret_access_key="s",
        path_style=False,
    )
    assert config.to_s3_config().path_style is False


def test_minio_resource_uses_s3_resource_type():
    resource = MinIOResource(
        MinIOConfig(
            bucket="my-bucket",
            endpoint_url="http://localhost:9000",
            access_key_id="k",
            secret_access_key="s",
        ))
    assert resource.name == ResourceName.S3
    assert resource.is_remote is True
    assert isinstance(resource.config, S3Config)


def test_minio_resource_preserves_original_config():
    config = MinIOConfig(
        bucket="my-bucket",
        endpoint_url="http://localhost:9000",
        access_key_id="k",
        secret_access_key="s",
    )
    resource = MinIOResource(config)
    assert resource.minio_config is config
