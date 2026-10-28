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

from mirage.core.api.errors import ApiError


class DatabricksVolumeCredentialError(RuntimeError):
    pass


class DatabricksVolumeApiError(ApiError):
    """A Databricks Files API call that failed, with its ``error_code``."""

    def __init__(
        self, message: str, status: int, error_code: str | None = None
    ) -> None:
        super().__init__(message, status)
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
            text or f"HTTP {response.status}", response.status
        )
    return DatabricksVolumeApiError(
        body.message or text or f"HTTP {response.status}",
        response.status,
        body.error_code,
    )


def is_not_found(exc: Exception) -> bool:
    return isinstance(exc, DatabricksVolumeApiError) and (
        exc.status == 404
        or (
            exc.status == 400
            and exc.error_code in {"RESOURCE_DOES_NOT_EXIST", "NOT_FOUND"}
        )
    )
