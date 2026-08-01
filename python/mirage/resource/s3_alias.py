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

from typing import ClassVar

from pydantic import BaseModel, ConfigDict, SecretStr

from mirage.resource.s3 import S3Config


class S3AliasConfig(BaseModel):
    """Shared shape for the S3-compatible providers.

    Every alias is the same handful of credentials plus one endpoint rule,
    so the fields, the redaction that rides on ``SecretStr``, and the
    conversion to :class:`S3Config` live here once. A provider declares
    only its endpoint rule and whatever it genuinely adds.

    Only ``bucket`` and whatever the endpoint genuinely needs are
    required. Credentials are optional everywhere because :class:`S3Config`
    leaves them optional too, so omitting them falls through to the usual
    AWS resolution order: ``aws_profile``, then the ``AWS_ACCESS_KEY_ID`` /
    ``AWS_SECRET_ACCESS_KEY`` environment variables, then the shared
    credentials file, then an instance role. Passing keys explicitly still
    wins. ``session_token`` and ``aws_profile`` live here rather than on
    the one provider that first needed them, so every alias accepts them.
    """

    model_config = ConfigDict(frozen=True)

    bucket: str
    region: str
    endpoint_url: str | None = None
    access_key_id: SecretStr | None = None
    secret_access_key: SecretStr | None = None
    session_token: SecretStr | None = None
    aws_profile: str | None = None
    path_style: bool = False
    key_prefix: str | None = None
    timeout: int = 30
    proxy: SecretStr | None = None

    def resolved_endpoint_url(self) -> str:
        raise NotImplementedError

    def to_s3_config(self) -> S3Config:
        return S3Config(
            bucket=self.bucket,
            region=self.region,
            endpoint_url=self.resolved_endpoint_url(),
            aws_access_key_id=self.access_key_id,
            aws_secret_access_key=self.secret_access_key,
            aws_session_token=self.session_token,
            aws_profile=self.aws_profile,
            path_style=self.path_style,
            key_prefix=self.key_prefix,
            timeout=self.timeout,
            proxy=self.proxy,
        )


class RegionEndpointConfig(S3AliasConfig):
    """A provider whose endpoint is derived from the region.

    ``ENDPOINT`` is a format string over the model's own fields, so a
    subclass usually declares nothing but that one line.
    """

    ENDPOINT: ClassVar[str] = ""

    def resolved_endpoint_url(self) -> str:
        if self.endpoint_url:
            return self.endpoint_url
        return self.ENDPOINT.format(**self.__dict__)


class FixedEndpointConfig(S3AliasConfig):
    """A provider only reachable at an endpoint the caller supplies.

    Self-hosted gateways (ceph, minio, seaweedfs) have no public region to
    derive from, so the endpoint is required and path-style is the default.
    """

    endpoint_url: str
    region: str = "us-east-1"
    path_style: bool = True

    def resolved_endpoint_url(self) -> str:
        return self.endpoint_url
