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
    """Credentials and bounds for one Airtable account.

    Args:
        token (SecretStr): a personal access token (or an OAuth access
            token), sent as ``Authorization: Bearer``.
        base_ids (list[str] | None): restrict the mount to these bases;
            None shows every base the token can reach.
        base_url (str): the API root, overridden to point at a fake.
        max_read_records (int): the most records one file may render. A
            full read of a table or view holding more stops at the cap
            rather than paging at 5 requests a second for minutes;
            ``head`` still reads its first lines.
        requests_per_second (float): pacing per base. Airtable allows 5
            and answers a burst with a 30-second penalty.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    token: SecretStr
    base_ids: list[str] | None = None
    base_url: str = "https://api.airtable.com/v0"
    max_read_records: int = Field(default=10_000, ge=1)
    requests_per_second: float = Field(default=5.0, gt=0)
