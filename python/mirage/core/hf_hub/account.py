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

from typing import Any

from mirage.accessor.hf_hub import HfAccountAccessor
from mirage.core.hf_hub.client import hub_get
from mirage.types import JsonValue


async def whoami(account: HfAccountAccessor) -> dict[str, Any]:
    """Who the account's token belongs to.

    Args:
        account (HfAccountAccessor): the install's account.

    Returns:
        dict[str, Any]: the decoded /whoami-v2 object.
    """
    url = f"{account.endpoint.rstrip('/')}/api/whoami-v2"
    data: JsonValue = await hub_get(account, url)
    return data if isinstance(data, dict) else {}
