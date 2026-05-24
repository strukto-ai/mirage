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

from mirage.resource.oci import OCIConfig, OCIResource
from mirage.resource.s3 import S3Config
from mirage.resource.secrets import reveal_secret
from mirage.types import ResourceName


def test_oci_config_defaults():
    config = OCIConfig(
        bucket="my-bucket",
        namespace="my-namespace",
        region="us-ashburn-1",
        access_key_id="access-key",
        secret_access_key="secret-key",
    )
    assert config.timeout == 30
    assert config.resolved_endpoint_url() == (
        "https://my-namespace.compat.objectstorage."
        "us-ashburn-1.oci.customer-oci.com")


def test_oci_config_immutable():
    config = OCIConfig(
        bucket="my-bucket",
        namespace="my-namespace",
        region="us-ashburn-1",
        access_key_id="access-key",
        secret_access_key="secret-key",
    )
    with pytest.raises(ValidationError):
        config.bucket = "other-bucket"


def test_oci_config_to_s3_config():
    config = OCIConfig(
        bucket="my-bucket",
        namespace="my-namespace",
        region="us-ashburn-1",
        access_key_id="access-key",
        secret_access_key="secret-key",
        proxy="http://localhost:8080",
    )
    s3_config = config.to_s3_config()
    assert isinstance(s3_config, S3Config)
    assert s3_config.bucket == "my-bucket"
    assert s3_config.region == "us-ashburn-1"
    assert s3_config.endpoint_url == (
        "https://my-namespace.compat.objectstorage."
        "us-ashburn-1.oci.customer-oci.com")
    assert reveal_secret(s3_config.aws_access_key_id) == "access-key"
    assert reveal_secret(s3_config.aws_secret_access_key) == "secret-key"
    assert s3_config.path_style is True
    assert s3_config.proxy == "http://localhost:8080"


def test_oci_config_custom_endpoint():
    config = OCIConfig(
        bucket="my-bucket",
        namespace="my-namespace",
        region="us-ashburn-1",
        endpoint_url="https://custom.example.com",
        access_key_id="access-key",
        secret_access_key="secret-key",
    )
    assert config.resolved_endpoint_url() == "https://custom.example.com"


def test_oci_resource_uses_s3_resource_type():
    resource = OCIResource(
        OCIConfig(
            bucket="my-bucket",
            namespace="my-namespace",
            region="us-ashburn-1",
            access_key_id="access-key",
            secret_access_key="secret-key",
        ))
    assert resource.name == ResourceName.S3
    assert resource.is_remote is True
    assert isinstance(resource.config, S3Config)
    assert resource.config.path_style is True


def test_oci_resource_preserves_original_config():
    config = OCIConfig(
        bucket="my-bucket",
        namespace="my-namespace",
        region="us-ashburn-1",
        access_key_id="access-key",
        secret_access_key="secret-key",
    )
    resource = OCIResource(config)
    assert resource.oci_config is config
