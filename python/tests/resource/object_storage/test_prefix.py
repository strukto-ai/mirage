from typing import Protocol

import pytest

from mirage.accessor.s3 import S3Config
from mirage.resource.aliyun import AliyunConfig
from mirage.resource.backblaze import BackblazeConfig
from mirage.resource.ceph import CephConfig
from mirage.resource.digitalocean import DigitalOceanConfig
from mirage.resource.gcs import GCSConfig
from mirage.resource.minio import MinIOConfig
from mirage.resource.oci import OCIConfig
from mirage.resource.qingstor import QingStorConfig
from mirage.resource.r2 import R2Config
from mirage.resource.scaleway import ScalewayConfig
from mirage.resource.seaweedfs import SeaweedFSConfig
from mirage.resource.supabase import SupabaseConfig
from mirage.resource.tencent import TencentConfig
from mirage.resource.wasabi import WasabiConfig


class S3AliasConfig(Protocol):

    def to_s3_config(self) -> S3Config:
        ...


CONFIGS = [
    AliyunConfig(bucket="b",
                 region="us-east-1",
                 endpoint_url="http://localhost:9000",
                 access_key_id="key",
                 secret_access_key="secret",
                 path_style=True,
                 key_prefix="/team/reports/"),
    BackblazeConfig(bucket="b",
                    region="us-east-1",
                    endpoint_url="http://localhost:9000",
                    access_key_id="key",
                    secret_access_key="secret",
                    path_style=True,
                    key_prefix="/team/reports/"),
    CephConfig(bucket="b",
               endpoint_url="http://localhost:9000",
               access_key_id="key",
               secret_access_key="secret",
               key_prefix="/team/reports/"),
    DigitalOceanConfig(bucket="b",
                       region="us-east-1",
                       endpoint_url="http://localhost:9000",
                       access_key_id="key",
                       secret_access_key="secret",
                       path_style=True,
                       key_prefix="/team/reports/"),
    GCSConfig(bucket="b",
              endpoint_url="http://localhost:9000",
              access_key_id="key",
              secret_access_key="secret",
              path_style=True,
              key_prefix="/team/reports/"),
    MinIOConfig(bucket="b",
                endpoint_url="http://localhost:9000",
                access_key_id="key",
                secret_access_key="secret",
                key_prefix="/team/reports/"),
    OCIConfig(bucket="b",
              namespace="namespace",
              region="us-east-1",
              endpoint_url="http://localhost:9000",
              access_key_id="key",
              secret_access_key="secret",
              key_prefix="/team/reports/"),
    QingStorConfig(bucket="b",
                   region="us-east-1",
                   endpoint_url="http://localhost:9000",
                   access_key_id="key",
                   secret_access_key="secret",
                   path_style=True,
                   key_prefix="/team/reports/"),
    R2Config(bucket="b",
             endpoint_url="http://localhost:9000",
             access_key_id="key",
             secret_access_key="secret",
             path_style=True,
             key_prefix="/team/reports/"),
    ScalewayConfig(bucket="b",
                   region="us-east-1",
                   endpoint_url="http://localhost:9000",
                   access_key_id="key",
                   secret_access_key="secret",
                   path_style=True,
                   key_prefix="/team/reports/"),
    SeaweedFSConfig(bucket="b",
                    endpoint_url="http://localhost:9000",
                    access_key_id="key",
                    secret_access_key="secret",
                    key_prefix="/team/reports/"),
    SupabaseConfig(bucket="b",
                   region="us-east-1",
                   endpoint_url="http://localhost:9000",
                   access_key_id="key",
                   secret_access_key="secret",
                   key_prefix="/team/reports/"),
    TencentConfig(bucket="b",
                  region="us-east-1",
                  endpoint_url="http://localhost:9000",
                  access_key_id="key",
                  secret_access_key="secret",
                  path_style=True,
                  key_prefix="/team/reports/"),
    WasabiConfig(bucket="b",
                 region="us-east-1",
                 endpoint_url="http://localhost:9000",
                 access_key_id="key",
                 secret_access_key="secret",
                 path_style=True,
                 key_prefix="/team/reports/"),
]


@pytest.mark.parametrize("config", CONFIGS)
def test_s3_alias_forwards_prefix_and_path_style(
        config: S3AliasConfig) -> None:
    s3 = config.to_s3_config()
    assert s3.key_prefix == "team/reports/"
    assert s3.path_style is True
