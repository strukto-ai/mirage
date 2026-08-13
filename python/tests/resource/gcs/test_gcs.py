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

from mirage.resource.gcs import GCSConfig, GCSResource
from mirage.resource.secrets import reveal_secret


def test_gcs_config_defaults():
    c = GCSConfig(
        bucket="my-bucket",
        access_key_id="GOOG123",
        secret_access_key="secret",
    )
    assert c.endpoint_url == "https://storage.googleapis.com"
    assert c.region == "auto"
    assert c.timeout == 30
    assert c.proxy is None


def test_gcs_config_immutable():
    c = GCSConfig(
        bucket="x",
        access_key_id="GOOG123",
        secret_access_key="secret",
    )
    with pytest.raises(ValidationError):
        c.bucket = "y"


def test_gcs_config_custom_endpoint():
    c = GCSConfig(
        bucket="my-bucket",
        access_key_id="GOOG123",
        secret_access_key="secret",
        endpoint_url="https://custom.endpoint.com",
    )
    assert c.endpoint_url == "https://custom.endpoint.com"


def test_gcs_to_s3_config():
    c = GCSConfig(
        bucket="my-bucket",
        access_key_id="GOOG123",
        secret_access_key="secret",
    )
    s3c = c.to_s3_config()
    assert s3c.bucket == "my-bucket"
    assert reveal_secret(s3c.aws_access_key_id) == "GOOG123"
    assert reveal_secret(s3c.aws_secret_access_key) == "secret"
    assert s3c.endpoint_url == "https://storage.googleapis.com"
    assert s3c.region == "auto"


def test_gcs_resource_creates():
    c = GCSConfig(
        bucket="my-bucket",
        access_key_id="GOOG123",
        secret_access_key="secret",
    )
    resource = GCSResource(c)
    assert resource.gcs_config is c
    assert resource.accessor.config.bucket == "my-bucket"
    expected = "https://storage.googleapis.com"
    assert resource.accessor.config.endpoint_url == expected
