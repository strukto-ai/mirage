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


class DatabricksVolumeApiError(RuntimeError):
    """A Files API answer the client could not use.

    Args:
        message (str): the rendered failure, method and URL included.
        status_code (int | None): HTTP status, when there was one.
        error_code (str | None): the Databricks ``error_code`` field,
            absent on a HEAD (which carries no body at all).
    """

    def __init__(self,
                 message: str,
                 status_code: int | None = None,
                 error_code: str | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code


class DatabricksVolumeAuthError(DatabricksVolumeApiError):
    """The workspace refused the configured token (401).

    Its own type because it is the one failure an application can act
    on: mirage never refreshes or replays, so an expired token reaches
    the caller as this error, and the fix is to obtain a fresh token
    and rebuild the resource with a new config.
    """


def is_not_found(exc: Exception) -> bool:
    status_code = getattr(exc, "status_code", None)
    if status_code == 404:
        return True
    error_code = getattr(exc, "error_code", None)
    if error_code in {"RESOURCE_DOES_NOT_EXIST", "NOT_FOUND"}:
        return True
    message = str(exc).lower()
    return "not found" in message or "does not exist" in message
