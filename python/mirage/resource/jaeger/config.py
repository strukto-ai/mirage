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

from pydantic import BaseModel


class JaegerConfig(BaseModel):
    host: str = "http://localhost:16686"
    default_trace_limit: int = 100
    # Jaeger's search endpoint takes an explicit microsecond window and its
    # `lookback` parameter is ignored, so a window is always sent. Unset means
    # "from the beginning": an implicit recent-only window would hide traces
    # that read() happily serves.
    default_from_timestamp: str | None = None
    default_to_timestamp: str | None = None
    request_timeout: int = 30
