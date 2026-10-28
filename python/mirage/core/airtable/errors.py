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

from mirage.core.airtable.constants import NOT_FOUND_TYPES
from mirage.core.api.errors import ApiError


class AirtableAPIError(ApiError):
    """A >= 400 answer from the Airtable API.

    Args:
        message (str): the rendered failure, naming the call.
        status (int | None): the HTTP status.
        error_type (str | None): Airtable's error type
            (``AUTHENTICATION_REQUIRED``, ``NOT_FOUND``, ...).
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        error_type: str | None = None,
    ) -> None:
        super().__init__(message, status)
        self.error_type = error_type

    @property
    def not_found(self) -> bool:
        """Whether the call named something the token cannot see.

        Airtable answers a well-formed id it cannot resolve with a 403,
        not a 404: the permission and the existence checks share one
        answer so a token cannot probe for bases it was not granted.
        """
        return self.status == 404 or self.error_type in NOT_FOUND_TYPES


def error_parts(text: str) -> tuple[str | None, str | None]:
    """Airtable's error type and message, from any of its body shapes.

    The API answers ``{"error": {"type", "message"}}``, the same object
    without a message, or a bare ``{"error": "NOT_FOUND"}`` for an
    unmatched route or a malformed id.

    Args:
        text (str): the response body.
    """
    try:
        data = json.loads(text)
    except ValueError:
        return None, None
    if not isinstance(data, dict):
        return None, None
    error = data.get("error")
    if isinstance(error, str):
        return error, None
    if isinstance(error, dict):
        kind = error.get("type")
        message = error.get("message")
        return (
            kind if isinstance(kind, str) else None,
            message if isinstance(message, str) else None,
        )
    return None, None
