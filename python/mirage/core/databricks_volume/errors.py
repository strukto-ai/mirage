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


class DatabricksVolumeCredentialError(RuntimeError):
    pass


class DatabricksVolumeApiError(Exception):
    def __init__(
        self, status_code: int, error_code: str | None, message: str
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code


class _ErrorBody(BaseModel):
    model_config = ConfigDict(strict=True)
    error_code: str | None = None
    message: str | None = None


def error_of(
    response: aiohttp.ClientResponse, text: str
) -> DatabricksVolumeApiError:
    try:
        body = _ErrorBody.model_validate_json(text)
    except ValidationError:
        return DatabricksVolumeApiError(
            response.status, None, text or f"HTTP {response.status}"
        )
    return DatabricksVolumeApiError(
        response.status,
        body.error_code,
        body.message or text or f"HTTP {response.status}",
    )


def is_not_found(exc: Exception) -> bool:
    return isinstance(exc, DatabricksVolumeApiError) and (
        exc.status_code == 404
        or (
            exc.status_code == 400
            and exc.error_code in {"RESOURCE_DOES_NOT_EXIST", "NOT_FOUND"}
        )
    )
