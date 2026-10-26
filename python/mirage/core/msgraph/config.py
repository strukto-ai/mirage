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

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from mirage.core.api.constants import DEFAULT_TIMEOUT

GRAPH_VERSION = "v1.0"
DEFAULT_GRAPH_API = f"https://graph.microsoft.com/{GRAPH_VERSION}"


class MsGraphConfig(BaseModel):
    model_config = ConfigDict(
        frozen=True, arbitrary_types_allowed=True, extra="forbid"
    )

    access_token: SecretStr | Callable[[], str | SecretStr]
    """Microsoft Graph bearer token, or a callable that returns one; it is
    called for each request and again after a `401`."""
    tenant_host: str | None = None
    """SharePoint host, such as `contoso.sharepoint.com`; the `sharepoint`
    mount lists only the sites whose `webUrl` is on it. The `onedrive`
    mount ignores it."""
    graph_base_url: str | None = None
    """Full Graph service root, version segment included, for any
    deployment but the worldwide one: a sovereign cloud, a private
    endpoint or a test server. Unset uses
    `https://graph.microsoft.com/v1.0`."""
    timeout: float = Field(default=DEFAULT_TIMEOUT, gt=0)
    """Seconds a Graph request may wait to connect, or between two reads of
    its answer, before it fails; also how long a server-side copy is polled
    before it fails as unconfirmed."""
    max_retries: int = 5
    """Times a request is retried after a `429`, `503` or `504` response.
    Each retry waits what `Retry-After` asks or an exponential backoff, at
    most 30 seconds."""


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
