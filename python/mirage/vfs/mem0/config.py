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

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PositiveInt,
    SecretStr,
    model_validator,
)

from mirage.vfs.constants import FULL_SCAN_LIMIT


class Mem0Config(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    api_key: SecretStr
    """Mem0 Platform API key."""
    host: str = "https://api.mem0.ai"
    """Mem0 API base URL."""
    user_id: str | None = None
    """Mount this user's memories. Set exactly one of `user_id`,
    `agent_id` and `run_id`."""
    agent_id: str | None = None
    """Mount this agent's memories. Set exactly one of `user_id`,
    `agent_id` and `run_id`."""
    run_id: str | None = None
    """Mount this run's memories. Set exactly one of `user_id`, `agent_id`
    and `run_id`."""
    default_page_size: PositiveInt = 100
    """Memories fetched per request while listing the scope."""
    default_search_limit: PositiveInt = 10
    """How many results `search` returns unless the line sets `top_k`."""
    full_scan_limit: int = Field(default=FULL_SCAN_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit."""

    @model_validator(mode="after")
    def _exactly_one_entity(self) -> "Mem0Config":
        present = [
            key
            for key in ("user_id", "agent_id", "run_id")
            if getattr(self, key) is not None
        ]
        if len(present) != 1:
            raise ValueError(
                "Mem0Config requires exactly one of "
                f"user_id, agent_id, run_id; got {present or 'none'}"
            )
        return self

    @property
    def scope_filter(self) -> dict[str, str]:
        if self.user_id is not None:
            return {"user_id": self.user_id}
        if self.agent_id is not None:
            return {"agent_id": self.agent_id}
        if self.run_id is not None:
            return {"run_id": self.run_id}
        raise RuntimeError("validated Mem0Config has no scope")
