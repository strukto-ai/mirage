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

from typing import TYPE_CHECKING, Any

from mirage.accessor.base import Accessor

if TYPE_CHECKING:
    from mirage.resource.databricks_volume.config import DatabricksVolumeConfig


class DatabricksVolumeAccessor(Accessor):

    def __init__(self, config: "DatabricksVolumeConfig", client: Any) -> None:
        self.config = config
        self.client = client

    @property
    def files(self) -> Any:
        return self.client.files
