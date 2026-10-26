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

from pydantic import BaseModel, ConfigDict, Field, SecretStr


class AirtableConfig(BaseModel):
    """Credentials and bounds for one Airtable account."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    token: SecretStr
    """Personal access token (or OAuth access token), sent as
    `Authorization: Bearer`."""
    base_ids: list[str] | None = None
    """Only these bases are listed or readable. Unset shows every base the
    token can reach."""
    base_url: str = "https://api.airtable.com/v0"
    """Airtable API root; override to point at a fake or proxy."""
    max_read_records: int = Field(default=10_000, ge=1)
    """The most records one file renders. A full read of a larger table or
    view fails with `File too large` once it passes the cap; `head -n N`
    still reads its first records."""
    requests_per_second: float = Field(default=5.0, gt=0)
    """Requests per second per base. Airtable allows 5 and answers a burst
    with a 30-second penalty."""
