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

from pymongo.asynchronous.database import AsyncDatabase

from mirage.accessor.mongodb import MongoClientAccessor
from mirage.vfs.gridfs.config import GridFSConfig


class GridFSAccessor(MongoClientAccessor):
    def __init__(self, config: GridFSConfig) -> None:
        super().__init__(config.uri, config.timeout)
        self.config = config

    def db(self) -> AsyncDatabase[dict[str, Any]]:
        return self.client[self.config.database]
