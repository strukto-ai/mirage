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

from collections.abc import Callable

from pydantic import BaseModel, ConfigDict, SecretStr

GRAPH_VERSION = "v1.0"
DEFAULT_GRAPH_API = f"https://graph.microsoft.com/{GRAPH_VERSION}"


class MsGraphConfig(BaseModel):
    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    access_token: SecretStr | Callable[[], str | SecretStr]
    tenant_host: str | None = None
    # Full service root, version segment included, for any deployment
    # other than the worldwide one: a sovereign cloud, a private
    # endpoint, or a test server.
    graph_base_url: str | None = None
    timeout: int = 30
    max_retries: int = 5


def graph_api(config: MsGraphConfig) -> str:
    """The Graph service root every URL for this mount hangs off.

    Read from the config rather than a module constant so two mounts in
    one process can address different deployments, and so a test server
    is reached by configuring a mount instead of rebinding a global in
    every module that spells a URL.

    Args:
        config (MsGraphConfig): mount config carrying the service root.
    """
    if config.graph_base_url:
        return config.graph_base_url.rstrip("/")
    return DEFAULT_GRAPH_API
