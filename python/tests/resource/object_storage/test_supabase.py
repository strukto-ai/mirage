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

from mirage.core.s3._client import _client_kwargs
from mirage.resource.s3 import S3Config
from mirage.resource.secrets import reveal_secret
from mirage.resource.supabase import SupabaseConfig, SupabaseResource
from mirage.types import ResourceName


def test_supabase_config_defaults():
    config = SupabaseConfig(
        bucket="my-bucket",
        project_ref="project-123",
        region="us-west-2",
        access_key_id="access-key",
        secret_access_key="secret-key",
    )
    assert config.timeout == 30
    assert config.resolved_endpoint_url() == (
        "https://project-123.storage.supabase.co/storage/v1/s3")


def test_supabase_config_immutable():
    config = SupabaseConfig(
        bucket="my-bucket",
        project_ref="project-123",
        region="us-west-2",
        access_key_id="access-key",
        secret_access_key="secret-key",
    )
    with pytest.raises(ValidationError):
        config.bucket = "other-bucket"


def test_supabase_config_to_s3_config():
    config = SupabaseConfig(
        bucket="my-bucket",
        endpoint_url="https://example.supabase.co/storage/v1/s3",
        region="us-west-2",
        access_key_id="access-key",
        secret_access_key="secret-key",
        session_token="session-token",
        proxy="http://localhost:8080",
    )
    s3_config = config.to_s3_config()
    assert isinstance(s3_config, S3Config)
    assert s3_config.bucket == "my-bucket"
    assert s3_config.region == "us-west-2"
    assert (
        s3_config.endpoint_url == "https://example.supabase.co/storage/v1/s3")
    assert reveal_secret(s3_config.aws_access_key_id) == "access-key"
    assert reveal_secret(s3_config.aws_secret_access_key) == "secret-key"
    assert reveal_secret(s3_config.aws_session_token) == "session-token"
    assert s3_config.path_style is True
    assert s3_config.proxy == "http://localhost:8080"


def test_supabase_config_requires_project_ref_or_endpoint():
    config = SupabaseConfig(
        bucket="my-bucket",
        region="us-west-2",
        access_key_id="access-key",
        secret_access_key="secret-key",
    )
    with pytest.raises(ValueError):
        config.resolved_endpoint_url()


def test_supabase_resource_uses_s3_resource_type():
    resource = SupabaseResource(
        SupabaseConfig(
            bucket="my-bucket",
            project_ref="project-123",
            region="us-west-2",
            access_key_id="access-key",
            secret_access_key="secret-key",
        ))
    assert resource.name == ResourceName.S3
    assert resource.is_remote is True
    assert isinstance(resource.config, S3Config)
    assert resource.config.path_style is True


def test_supabase_resource_preserves_original_config():
    config = SupabaseConfig(
        bucket="my-bucket",
        project_ref="project-123",
        region="us-west-2",
        access_key_id="access-key",
        secret_access_key="secret-key",
    )
    resource = SupabaseResource(config)
    assert resource.supabase_config is config


def test_s3_client_kwargs_support_path_style_and_session_token():
    config = S3Config(
        bucket="my-bucket",
        region="us-west-2",
        endpoint_url="https://example.com",
        aws_access_key_id="access-key",
        aws_secret_access_key="secret-key",
        aws_session_token="session-token",
        path_style=True,
    )
    kwargs = _client_kwargs(config)
    assert kwargs["aws_session_token"] == "session-token"
    assert kwargs["config"].s3 == {"addressing_style": "path"}
