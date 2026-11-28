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

from mirage.accessor.base import SessionAccessor
from mirage.core.tavily.config import TavilyConfig


class TavilyAccessor(SessionAccessor):
    """One Tavily account: its key, the API root and the pool calls ride.

    Args:
        config (TavilyConfig): the key, base URL and timeout.
    """

    def __init__(self, config: TavilyConfig) -> None:
        super().__init__(config.timeout, retry_connection=False)
        self.config = config
