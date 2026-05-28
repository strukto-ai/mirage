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

from pydantic import BaseModel, ConfigDict, SecretStr

from mirage.resource.s3 import S3Config


class QingStorConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    bucket: str
    region: str
    endpoint_url: str | None = None
    access_key_id: SecretStr
    secret_access_key: SecretStr
    timeout: int = 30
    proxy: str | None = None

    def resolved_endpoint_url(self) -> str:
        if self.endpoint_url:
            return self.endpoint_url
        return f"https://s3.{self.region}.qingstor.com"

    def to_s3_config(self) -> S3Config:
        return S3Config(
            bucket=self.bucket,
            region=self.region,
            endpoint_url=self.resolved_endpoint_url(),
            aws_access_key_id=self.access_key_id,
            aws_secret_access_key=self.secret_access_key,
            timeout=self.timeout,
            proxy=self.proxy,
        )
