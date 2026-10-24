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

from pydantic import ConfigDict, Field, SecretStr, field_validator

from mirage.secrets.config import AWSAuth
from mirage.utils import key_prefix as kp
from mirage.vfs.constants import WALK_LIMIT


class S3Config(AWSAuth):
    model_config = ConfigDict(frozen=True, extra="forbid")

    bucket: str
    """Name of the bucket to mount."""
    endpoint_url: str | None = None
    """Endpoint URL of an S3-compatible server. Unset uses
    `AWS_ENDPOINT_URL_S3` or `AWS_ENDPOINT_URL` when set, else AWS's
    endpoint for `region`; an endpoint set only in an AWS profile is not
    read."""
    path_style: bool = False
    """Address the bucket in the URL path (`<endpoint>/<bucket>/<key>`)
    instead of as a subdomain of the endpoint."""
    timeout: int = 30
    """Seconds to wait to connect, and for each read of a response, before
    the request fails."""
    proxy: SecretStr | None = None
    """Proxy URL for every HTTP and HTTPS request to the endpoint."""
    key_prefix: str | None = None
    """Key prefix inside the bucket that the mount treats as its root; keys
    outside it are not visible. Leading slashes are dropped and a trailing
    `/` is added."""
    default_content_type: str | None = None
    """`Content-Type` stored with every object the mount writes. Unset
    sends none, so the store applies its own default."""
    walk_limit: int = Field(default=WALK_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit."""

    @field_validator("key_prefix")
    @classmethod
    def _normalize_key_prefix(cls, v: str | None) -> str | None:
        return kp.normalize(v) or None
