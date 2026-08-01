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
from pydantic import SecretStr

from mirage.resource.aliyun.config import AliyunConfig
from mirage.resource.backblaze.config import BackblazeConfig
from mirage.resource.ceph.config import CephConfig
from mirage.resource.digitalocean.config import DigitalOceanConfig
from mirage.resource.gcs.config import GCSConfig
from mirage.resource.minio.config import MinIOConfig
from mirage.resource.oci.config import OCIConfig
from mirage.resource.qingstor.config import QingStorConfig
from mirage.resource.r2.config import R2Config
from mirage.resource.scaleway.config import ScalewayConfig
from mirage.resource.seaweedfs.config import SeaweedFSConfig
from mirage.resource.supabase.config import SupabaseConfig
from mirage.resource.tencent.config import TencentConfig
from mirage.resource.wasabi.config import WasabiConfig

# Mirrors typescript/packages/node/src/resource/s3_aliases.test.ts. Every
# provider is a thin wrapper over S3Config, so what needs pinning is the
# endpoint rule, the override path, and that the shared fields reach S3Config
# unchanged.

_CREDS = {
    "access_key_id": SecretStr("AKIA"),
    "secret_access_key": SecretStr("SECRET"),
}

# (name, class, region, expected endpoint for that region)
REGION_DERIVED = [
    ("aliyun", AliyunConfig, "cn-hangzhou",
     "https://s3.oss-cn-hangzhou.aliyuncs.com"),
    ("tencent", TencentConfig, "ap-guangzhou",
     "https://cos.ap-guangzhou.myqcloud.com"),
    ("backblaze", BackblazeConfig, "us-west-002",
     "https://s3.us-west-002.backblazeb2.com"),
    ("digitalocean", DigitalOceanConfig, "nyc3",
     "https://nyc3.digitaloceanspaces.com"),
    ("qingstor", QingStorConfig, "pek3b", "https://s3.pek3b.qingstor.com"),
    ("scaleway", ScalewayConfig, "fr-par", "https://s3.fr-par.scw.cloud"),
    ("wasabi", WasabiConfig, "eu-central-1",
     "https://s3.eu-central-1.wasabisys.com"),
]

# Providers whose endpoint_url is required and taken verbatim.
ENDPOINT_REQUIRED = [
    ("ceph", CephConfig),
    ("minio", MinIOConfig),
    ("seaweedfs", SeaweedFSConfig),
]


@pytest.mark.parametrize("name,cls,region,expected", REGION_DERIVED)
def test_region_derived_endpoint(name, cls, region, expected):
    cfg = cls(bucket="b", region=region, **_CREDS)
    assert cfg.resolved_endpoint_url() == expected


@pytest.mark.parametrize("name,cls,region,expected", REGION_DERIVED)
def test_explicit_endpoint_overrides_the_region_rule(name, cls, region,
                                                     expected):
    cfg = cls(bucket="b",
              region=region,
              endpoint_url="https://custom.example",
              **_CREDS)
    assert cfg.resolved_endpoint_url() == "https://custom.example"


@pytest.mark.parametrize("name,cls,region,expected", REGION_DERIVED)
def test_region_derived_maps_onto_s3_config(name, cls, region, expected):
    cfg = cls(bucket="b",
              region=region,
              key_prefix="pre/",
              timeout=7,
              **_CREDS)
    s3 = cfg.to_s3_config()
    assert s3.bucket == "b"
    assert s3.region == region
    assert s3.endpoint_url == expected
    assert s3.aws_access_key_id.get_secret_value() == "AKIA"
    assert s3.aws_secret_access_key.get_secret_value() == "SECRET"
    assert s3.key_prefix == "pre/"
    assert s3.timeout == 7
    assert s3.path_style is False


@pytest.mark.parametrize("name,cls", ENDPOINT_REQUIRED)
def test_endpoint_required_defaults(name, cls):
    cfg = cls(bucket="b", endpoint_url="https://host:9000", **_CREDS)
    s3 = cfg.to_s3_config()
    assert s3.endpoint_url == "https://host:9000"
    assert s3.region == "us-east-1"
    assert s3.path_style is True


@pytest.mark.parametrize("name,cls", ENDPOINT_REQUIRED)
def test_endpoint_required_path_style_override(name, cls):
    cfg = cls(bucket="b",
              endpoint_url="https://host:9000",
              path_style=False,
              **_CREDS)
    assert cfg.to_s3_config().path_style is False


@pytest.mark.parametrize("name,cls,region,expected", REGION_DERIVED)
def test_proxy_reaches_s3_config(name, cls, region, expected):
    cfg = cls(bucket="b",
              region=region,
              proxy=SecretStr("http://proxy:3128"),
              **_CREDS)
    assert cfg.to_s3_config().proxy.get_secret_value() == "http://proxy:3128"


@pytest.mark.parametrize("name,cls,region,expected", REGION_DERIVED)
def test_credentials_may_be_omitted_for_ambient_resolution(
        name, cls, region, expected):
    s3 = cls(bucket="b", region=region).to_s3_config()
    assert s3.aws_access_key_id is None
    assert s3.aws_secret_access_key is None


@pytest.mark.parametrize("name,cls,region,expected", REGION_DERIVED)
def test_every_alias_forwards_the_aws_profile(name, cls, region, expected):
    cfg = cls(bucket="b", region=region, aws_profile="prod")
    assert cfg.to_s3_config().aws_profile == "prod"


@pytest.mark.parametrize("name,cls,region,expected", REGION_DERIVED)
def test_every_alias_forwards_the_session_token(name, cls, region, expected):
    cfg = cls(bucket="b",
              region=region,
              session_token=SecretStr("tok"),
              **_CREDS)
    assert cfg.to_s3_config().aws_session_token.get_secret_value() == "tok"


@pytest.mark.parametrize("name,cls", ENDPOINT_REQUIRED)
def test_self_hosted_aliases_forward_the_aws_profile(name, cls):
    cfg = cls(bucket="b", endpoint_url="https://host:9000", aws_profile="prod")
    assert cfg.to_s3_config().aws_profile == "prod"


def test_wasabi_defaults_to_the_regionless_host():
    cfg = WasabiConfig(bucket="b", **_CREDS)
    assert cfg.region == "us-east-1"
    assert cfg.resolved_endpoint_url() == "https://s3.wasabisys.com"


def test_wasabi_explicit_endpoint_wins_over_the_regionless_host():
    cfg = WasabiConfig(bucket="b",
                       endpoint_url="https://custom.example",
                       **_CREDS)
    assert cfg.resolved_endpoint_url() == "https://custom.example"


@pytest.mark.parametrize("name,cls", [("oci", OCIConfig),
                                      ("supabase", SupabaseConfig)])
def test_namespace_providers_default_to_path_style(name, cls):
    extra = {"namespace": "ns"} if name == "oci" else {"project_ref": "abc"}
    cfg = cls(bucket="b", region="us-east-1", **extra, **_CREDS)
    assert cfg.to_s3_config().path_style is True


def test_gcs_uses_a_fixed_endpoint():
    s3 = GCSConfig(bucket="b", **_CREDS).to_s3_config()
    assert s3.endpoint_url == "https://storage.googleapis.com"
    assert s3.region == "auto"


def test_oci_endpoint_uses_namespace_and_region():
    cfg = OCIConfig(bucket="b", namespace="ns", region="us-ashburn-1", **_CREDS)
    assert cfg.resolved_endpoint_url() == (
        "https://ns.compat.objectstorage.us-ashburn-1.oci.customer-oci.com")


def test_r2_endpoint_uses_account_id():
    cfg = R2Config(bucket="b", account_id="acct", **_CREDS)
    assert cfg.resolved_endpoint_url() == (
        "https://acct.r2.cloudflarestorage.com")


def test_r2_without_account_id_or_endpoint_raises():
    with pytest.raises(ValueError, match="account_id or endpoint_url"):
        R2Config(bucket="b", **_CREDS).resolved_endpoint_url()


def test_r2_forwards_the_aws_profile():
    cfg = R2Config(bucket="b", account_id="acct", aws_profile="prod")
    assert cfg.to_s3_config().aws_profile == "prod"


def test_supabase_endpoint_uses_project_ref():
    cfg = SupabaseConfig(bucket="b",
                         region="us-east-1",
                         project_ref="abc",
                         **_CREDS)
    assert cfg.resolved_endpoint_url() == (
        "https://abc.storage.supabase.co/storage/v1/s3")


def test_supabase_forwards_the_session_token():
    cfg = SupabaseConfig(bucket="b",
                         region="us-east-1",
                         project_ref="abc",
                         session_token=SecretStr("tok"),
                         **_CREDS)
    s3 = cfg.to_s3_config()
    assert s3.aws_session_token.get_secret_value() == "tok"


@pytest.mark.parametrize("name,cls,region,expected", REGION_DERIVED)
def test_configs_are_frozen(name, cls, region, expected):
    cfg = cls(bucket="b", region=region, **_CREDS)
    with pytest.raises(Exception):
        cfg.bucket = "other"
