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

from pydantic import ConfigDict, SecretStr

from mirage.core.api.config import TimeoutConfig


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
