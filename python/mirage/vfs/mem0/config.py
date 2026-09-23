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

from typing import Literal

from pydantic import BaseModel, PositiveInt, SecretStr, model_validator

ScopeKind = Literal["user", "agent", "run"]


class Mem0Config(BaseModel):
    api_key: SecretStr
    host: str = "https://api.mem0.ai"
    user_id: str | None = None
    agent_id: str | None = None
    run_id: str | None = None
    default_page_size: PositiveInt = 100
    default_search_limit: PositiveInt = 10

    @model_validator(mode="after")
    def _exactly_one_entity(self) -> "Mem0Config":
        present = [
            key for key in ("user_id", "agent_id", "run_id")
            if getattr(self, key) is not None
        ]
        if len(present) != 1:
            raise ValueError(
                "Mem0Config requires exactly one of "
                f"user_id, agent_id, run_id; got {present or 'none'}")
        return self

    @property
    def scope_kind(self) -> ScopeKind:
        if self.user_id is not None:
            return "user"
        if self.agent_id is not None:
            return "agent"
        if self.run_id is not None:
            return "run"
        raise RuntimeError("validated Mem0Config has no scope")

    @property
    def scope_filter(self) -> dict[str, str]:
        if self.user_id is not None:
            return {"user_id": self.user_id}
        if self.agent_id is not None:
            return {"agent_id": self.agent_id}
        if self.run_id is not None:
            return {"run_id": self.run_id}
        raise RuntimeError("validated Mem0Config has no scope")
