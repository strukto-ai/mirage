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

import json

from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagValue
from mirage.types import JsonValue


def parse_json_flag(value: FlagValue | None,
                    flag: str) -> dict[str, JsonValue]:
    """Parse a JSON-object flag, sharing the gws wording.

    Args:
        value (FlagValue | None): the raw flag value from the bag.
        flag (str): the flag's spelling for error messages.

    Returns:
        dict: the parsed object, empty when the flag is absent.
    """
    if value is None or value == "":
        return {}
    if not isinstance(value, str):
        raise UsageError(f"{flag} must be a JSON string")
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        # One wording in both languages: the engines' own parse messages
        # ("Expecting value" vs "Unexpected token") can never agree.
        raise UsageError(f"{flag} must be valid JSON") from exc
    if not isinstance(parsed, dict):
        raise UsageError(f"{flag} must be a JSON object")
    return parsed
