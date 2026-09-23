from typing import Protocol

import pytest

from mirage.accessor.s3 import S3Config
from mirage.vfs.aliyun import AliyunConfig
from mirage.vfs.backblaze import BackblazeConfig
from mirage.vfs.ceph import CephConfig
from mirage.vfs.digitalocean import DigitalOceanConfig
from mirage.vfs.gcs import GCSConfig
from mirage.vfs.minio import MinIOConfig
from mirage.vfs.oci import OCIConfig
from mirage.vfs.qingstor import QingStorConfig
from mirage.vfs.r2 import R2Config
from mirage.vfs.scaleway import ScalewayConfig
from mirage.vfs.seaweedfs import SeaweedFSConfig
from mirage.vfs.supabase import SupabaseConfig
from mirage.vfs.tencent import TencentConfig
from mirage.vfs.wasabi import WasabiConfig


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
