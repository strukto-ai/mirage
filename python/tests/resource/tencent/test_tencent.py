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

from mirage.resource.s3 import S3Config
from mirage.resource.secrets import reveal_secret
from mirage.resource.tencent import TencentConfig, TencentResource
from mirage.types import ResourceName


def test_tencent_regional_endpoint():
    config = TencentConfig(bucket="b-1250",
                           region="ap-guangzhou",
                           access_key_id="k",
                           secret_access_key="s")
    assert config.resolved_endpoint_url() == (
        "https://cos.ap-guangzhou.myqcloud.com")


def test_tencent_requires_region():
    with pytest.raises(ValidationError):
        TencentConfig(bucket="b", access_key_id="k", secret_access_key="s")


def test_tencent_custom_endpoint_override():
    config = TencentConfig(bucket="b",
                           region="ap-beijing",
                           endpoint_url="https://custom.example.com",
                           access_key_id="k",
                           secret_access_key="s")
    assert config.resolved_endpoint_url() == "https://custom.example.com"


def test_tencent_to_s3_config():
    config = TencentConfig(bucket="b-1250",
                           region="ap-singapore",
                           access_key_id="key",
                           secret_access_key="secret")
    s3 = config.to_s3_config()
    assert isinstance(s3, S3Config)
    assert s3.endpoint_url == "https://cos.ap-singapore.myqcloud.com"
    assert reveal_secret(s3.aws_access_key_id) == "key"


def test_tencent_resource_uses_s3_resource_type():
    resource = TencentResource(
        TencentConfig(bucket="b-1250",
                      region="ap-guangzhou",
                      access_key_id="k",
                      secret_access_key="s"))
    assert resource.name == ResourceName.S3
    assert isinstance(resource.config, S3Config)
