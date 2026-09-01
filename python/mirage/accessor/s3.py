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

from typing import Any

from pydantic import ConfigDict, SecretStr, field_validator

from mirage.accessor.base import Accessor
from mirage.accessor.pool import ClientFactory, LoopClientCache
from mirage.secrets.config import AWSAuth
from mirage.utils import key_prefix as kp


class S3Config(AWSAuth):
    model_config = ConfigDict(frozen=True)

    bucket: str
    endpoint_url: str | None = None
    path_style: bool = False
    timeout: int = 30
    proxy: SecretStr | None = None
    key_prefix: str | None = None

    @field_validator("key_prefix")
    @classmethod
    def _normalize_key_prefix(cls, v: str | None) -> str | None:
        return kp.normalize(v) or None


class S3Accessor(Accessor):

    def __init__(self, config: S3Config) -> None:
        self.config = config
        # One live client per event loop, the way GridFSAccessor keeps its
        # motor client. Opening one costs ~50ms (botocore builds the S3
        # service model and a fresh connection pool), so the old
        # client-per-operation made every op 24x its own cost.
        #
        # The cache owns the lifetime and the driver owns the construction:
        # building a client needs the kwargs helpers in mirage.core.s3.client,
        # and that module imports S3Config from here, so constructing one here
        # would be a cycle.
        self._clients = LoopClientCache("s3")

    async def cached_client(self, factory: ClientFactory) -> Any:
        """Return this loop's open client, opening one when there is none.

        Args:
            factory (ClientFactory): builds the client manager, called
                only when this loop has no client yet.

        Returns:
            Any: the open aioboto3 client for the running loop.
        """
        return await self._clients.get(factory)

    async def close(self) -> None:
        """Close every client this accessor opened."""
        await self._clients.close()
