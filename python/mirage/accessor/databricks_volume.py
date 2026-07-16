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

from mirage.accessor.base import Accessor
from mirage.resource.databricks_volume.config import DatabricksVolumeConfig

try:
    from databricks.sdk import WorkspaceClient
    from databricks.sdk.config import Config as WorkspaceConfig
except ImportError:
    WorkspaceConfig = None  # type: ignore[misc, assignment]
    WorkspaceClient = None  # type: ignore[misc, assignment]


class DatabricksVolumeAccessor(Accessor):

    def __init__(
        self,
        config: DatabricksVolumeConfig,
        client: Any | None = None,
    ) -> None:
        self.config = config
        self._client = client

    @property
    def client(self) -> Any:
        if self._client is None:
            if WorkspaceClient is None or WorkspaceConfig is None:
                raise ImportError("DatabricksVolumeResource requires the "
                                  "'databricks' extra. Install with: "
                                  "pip install mirage-ai[databricks]")
            kwargs: dict[str, Any] = {
                "host": self.config.host,
                "token": self.config.token,
                "profile": self.config.profile,
                "auth_type": "pat" if self.config.token is not None else None,
                "http_timeout_seconds": self.config.timeout,
            }
            sdk_config = WorkspaceConfig(**{
                k: v
                for k, v in kwargs.items() if v is not None
            })
            self._client = WorkspaceClient(config=sdk_config)
        return self._client

    @property
    def files(self) -> Any:
        return self.client.files
