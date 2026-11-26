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

from pydantic import ConfigDict, SecretStr, ValidationInfo, field_validator

from mirage.core.api.config import TimeoutConfig
from mirage.vfs.secrets import reveal_secret


class LangfuseConfig(TimeoutConfig):
    model_config = ConfigDict(frozen=True, extra="forbid")

    public_key: str
    """Langfuse project public key."""
    secret_key: SecretStr
    """Langfuse project secret key."""
    host: str = "https://cloud.langfuse.com"
    """Langfuse API host; override for a self-hosted or regional
    instance."""
    default_trace_limit: int = 100
    """The most traces one trace listing (`traces/` or a session's traces)
    shows. An older trace is still readable by its id."""
    default_from_timestamp: str | None = None
    """List only traces from this ISO 8601 timestamp on. Unset lists
    whatever the project holds, up to `default_trace_limit`."""

    @field_validator("public_key", "secret_key")
    @classmethod
    def _key_is_set(
        cls, value: str | SecretStr, info: ValidationInfo
    ) -> str | SecretStr:
        """Refuse an empty key, which the Langfuse client would replace
        with ``LANGFUSE_PUBLIC_KEY`` or ``LANGFUSE_SECRET_KEY`` from the
        process environment."""
        if not reveal_secret(value).strip():
            raise ValueError(f"Langfuse {info.field_name} cannot be empty")
        return value
