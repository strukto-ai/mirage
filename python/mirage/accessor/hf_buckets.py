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

from pydantic import BaseModel, ConfigDict, SecretStr, field_validator

from mirage.accessor._hf import _HfAccessor
from mirage.utils import key_prefix as kp


class HfBucketsConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    bucket: str
    token: SecretStr | None = None
    endpoint: str = "https://huggingface.co"
    timeout: int = 30
    key_prefix: str | None = None

    @field_validator("bucket")
    @classmethod
    def _validate_bucket(cls, v: str) -> str:
        parts = v.split("/")
        if len(parts) != 2 or not parts[0] or not parts[1]:
            raise ValueError(
                f"bucket must be in 'namespace/name' form; got {v!r}")
        return v

    @field_validator("key_prefix")
    @classmethod
    def _normalize_key_prefix(cls, v: str | None) -> str | None:
        return kp.normalize(v) or None

    @property
    def namespace(self) -> str:
        return self.bucket.split("/", 1)[0]

    @property
    def bucket_name(self) -> str:
        return self.bucket.split("/", 1)[1]


class HfBucketsAccessor(_HfAccessor):
    """A mount onto one Hugging Face bucket.

    Listing and writes go through the opendal operator; stat's point lookup
    and every read go to the Hub over the pool, because the bucket's
    content token (its xet hash) comes from paths-info and the resolve
    download, neither of which the binding exposes.
    """

    REPO_TYPE = "bucket"
    VFS_NAME = "hf_buckets"
    config: HfBucketsConfig

    @property
    def bucket_uri(self) -> str:
        return f"hf://buckets/{self.config.bucket}"

    @property
    def endpoint(self) -> str:
        return self.config.endpoint

    @property
    def token(self) -> SecretStr | None:
        return self.config.token

    @property
    def key_prefix(self) -> str:
        return self.config.key_prefix or ""

    def bucket_path(self, rel: str) -> str:
        """Lift a mount-relative path to its bucket-relative spelling.

        opendal applies the key prefix as its operator root; a Hub call
        made directly has to apply it here instead.

        Args:
            rel (str): the path as the mount sees it.

        Returns:
            str: the path the Hub knows it by.
        """
        # Empty segments are dropped: opendal normalizes its root the same
        # way, and the Hub matches paths exactly, so `a//b/x` would name a
        # file the listing shows as `a/b/x` and answer it absent.
        parts = [p for p in f"{self.key_prefix}/{rel}".split("/") if p]
        return "/".join(parts)
