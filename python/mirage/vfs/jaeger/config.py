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

from pydantic import ConfigDict

from mirage.core.api.config import TimeoutConfig


class JaegerConfig(TimeoutConfig):
    model_config = ConfigDict(frozen=True, extra="forbid")

    host: str = "http://localhost:16686"
    """Jaeger query service URL."""
    default_trace_limit: int = 100
    """The most traces one service's `traces/` listing shows, newest first.
    An older trace is still readable by its id."""
    # Jaeger's search endpoint takes an explicit microsecond window and its
    # `lookback` parameter is ignored, so a window is always sent. Unset means
    # "from the beginning": an implicit recent-only window would hide traces
    # that read() happily serves.
    default_from_timestamp: str | None = None
    """Lower bound of trace listings, an ISO 8601 timestamp. Unset searches
    from the beginning."""
    default_to_timestamp: str | None = None
    """Upper bound of trace listings, an ISO 8601 timestamp. Unset means
    now."""
