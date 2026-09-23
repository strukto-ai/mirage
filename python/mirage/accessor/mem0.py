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

from mem0 import AsyncMemoryClient

from mirage.accessor.base import Accessor
from mirage.vfs.mem0.config import Mem0Config
from mirage.vfs.secrets import reveal_secret


class Mem0Accessor(Accessor):

    def __init__(self, config: Mem0Config) -> None:
        self.config = config
        self._client: AsyncMemoryClient | None = None

    @property
    def client(self) -> AsyncMemoryClient:
        if self._client is None:
            self._client = AsyncMemoryClient(
                api_key=reveal_secret(self.config.api_key),
                host=self.config.host,
            )
        return self._client
