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


class LinearConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    api_key: SecretStr
    """Linear personal API key."""
    workspace: str | None = None
    """Accepted for compatibility; not read."""
    team_ids: list[str] | None = None
    """Only these teams are listed or readable. Unset shows every team the
    key can reach."""
    base_url: str = "https://api.linear.app/graphql"
    """Linear GraphQL endpoint; override to point at a fake or proxy."""
    content_search: bool = False
    """Let `grep -rw` and `rg -w` read only the issues Linear's search names,
    plus those whose other fields hold the word. Search lags writes."""
