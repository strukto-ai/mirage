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

import aiohttp
from pydantic import BaseModel, ConfigDict, ValidationError


class TiDBFilesystemApiError(Exception):
    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


class _ErrorBody(BaseModel):
    model_config = ConfigDict(strict=True)
    error: str | None = None


def error_of(
    response: aiohttp.ClientResponse, text: str
) -> TiDBFilesystemApiError:
    try:
        body = _ErrorBody.model_validate_json(text)
    except ValidationError:
        return TiDBFilesystemApiError(
            response.status, text or f"HTTP {response.status}"
        )
    return TiDBFilesystemApiError(
        response.status, body.error or text or f"HTTP {response.status}"
    )


def has_status(exc: Exception, status: int) -> bool:
    return isinstance(exc, TiDBFilesystemApiError) and (
        exc.status_code == status
    )
