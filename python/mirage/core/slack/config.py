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


class SlackConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    token: SecretStr
    """Slack token every API call sends: a bot token (`xoxb-`) or a user
    token (`xoxp-`)."""
    search_token: SecretStr | None = None
    """User token (`xoxp-`) with `search:read`, used only for Slack's
    `search.*` methods, which refuse a bot token. Unset searches with
    `token`."""
    base_url: str = "https://slack.com/api"
    """Slack Web API root; override to point at a fake or proxy."""
