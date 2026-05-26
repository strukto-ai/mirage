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

from mirage.accessor.base import Accessor
from mirage.utils import key_prefix as kp


class HfBucketsConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

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


class HfBucketsAccessor(Accessor):

    def __init__(self, config: HfBucketsConfig) -> None:
        self.config = config

    @property
    def bucket_uri(self) -> str:
        return f"hf://buckets/{self.config.bucket}"
