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

from mirage.resource.ceph import CephConfig, CephResource
from mirage.resource.s3 import S3Config
from mirage.resource.secrets import reveal_secret
from mirage.types import ResourceName


def test_ceph_config_defaults():
    config = CephConfig(
        bucket="my-bucket",
        endpoint_url="https://ceph.example.com",
        access_key_id="k",
        secret_access_key="s",
    )
    assert config.region == "us-east-1"
    assert config.path_style is True


def test_ceph_config_immutable():
    config = CephConfig(
        bucket="my-bucket",
        endpoint_url="https://ceph.example.com",
        access_key_id="k",
        secret_access_key="s",
    )
    with pytest.raises(ValidationError):
        config.bucket = "other"


def test_ceph_config_to_s3_config():
    config = CephConfig(
        bucket="my-bucket",
        endpoint_url="https://ceph.example.com",
        access_key_id="key",
        secret_access_key="secret",
    )
    s3 = config.to_s3_config()
    assert isinstance(s3, S3Config)
    assert s3.endpoint_url == "https://ceph.example.com"
    assert s3.path_style is True
    assert reveal_secret(s3.aws_access_key_id) == "key"
    assert reveal_secret(s3.aws_secret_access_key) == "secret"


def test_ceph_resource_uses_s3_resource_type():
    resource = CephResource(
        CephConfig(
            bucket="my-bucket",
            endpoint_url="https://ceph.example.com",
            access_key_id="k",
            secret_access_key="s",
        ))
    assert resource.name == ResourceName.S3
    assert isinstance(resource.config, S3Config)
    assert resource.ceph_config.endpoint_url == "https://ceph.example.com"
