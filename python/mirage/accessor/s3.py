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


class S3Config(BaseModel):
    model_config = ConfigDict(frozen=True)

    bucket: str
    region: str | None = None
    endpoint_url: str | None = None
    aws_access_key_id: SecretStr | None = None
    aws_secret_access_key: SecretStr | None = None
    aws_session_token: SecretStr | None = None
    aws_profile: str | None = None
    path_style: bool = False
    timeout: int = 30
    proxy: str | None = None
    key_prefix: str | None = None

    @field_validator("key_prefix")
    @classmethod
    def _normalize_key_prefix(cls, v: str | None) -> str | None:
        return kp.normalize(v) or None


class S3Accessor(Accessor):

    def __init__(self, config: S3Config) -> None:
        self.config = config
