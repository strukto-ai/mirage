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
from enum import Enum

from pydantic import BaseModel, ConfigDict, SecretStr

GRAPH_VERSION = "v1.0"


class GraphCloud(str, Enum):
    """A Microsoft Graph national cloud deployment.

    Each is a network-isolated instance with its own service root, and a
    token minted for one is not accepted by another. Microsoft 365 GCC
    (moderate) is served by the worldwide endpoint, so it is ``GLOBAL``;
    only GCC High and DoD have their own hosts.
    """
    GLOBAL = "global"
    US_GOV_HIGH = "usgovhigh"
    US_GOV_DOD = "usgovdod"
    CHINA = "china"


GRAPH_CLOUD_HOSTS = {
    GraphCloud.GLOBAL: "https://graph.microsoft.com",
    GraphCloud.US_GOV_HIGH: "https://graph.microsoft.us",
    GraphCloud.US_GOV_DOD: "https://dod-graph.microsoft.us",
    GraphCloud.CHINA: "https://microsoftgraph.chinacloudapi.cn",
}


class MsGraphConfig(BaseModel):
    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    access_token: SecretStr | Callable[[], str | SecretStr]
    tenant_host: str | None = None
    cloud: GraphCloud = GraphCloud.GLOBAL
    # Full service root, version segment included, for a deployment the
    # `cloud` table cannot name: a private endpoint or a test server. Wins
    # over `cloud` when set.
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
        config (MsGraphConfig): mount config carrying the deployment.
    """
    if config.graph_base_url:
        return config.graph_base_url.rstrip("/")
    return f"{GRAPH_CLOUD_HOSTS[config.cloud]}/{GRAPH_VERSION}"
