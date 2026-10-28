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


class ApiError(Exception):
    """A service answered a call with an error.

    The one base every backend's service error shares, so a caller
    catches any of them by one type and reads the status the same way.
    A service's own error code stays on its subclass, under the name the
    service gives it.

    Args:
        message (str): the failure, in the service's words where it gave
            any.
        status (int | None): the HTTP status, None when the failure
            carried none (an ``ok: false`` payload, a body that is not
            the expected shape).
    """

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class PaginationStalledError(RuntimeError):
    """A paginated endpoint handed back a cursor it had already sent.

    Following it would request a page already collected, forever; stopping
    quietly would return a listing that looks complete and is not. Either
    way the caller would be misled, so the walk fails instead.

    Args:
        cursor (str): the cursor that came back a second time.
    """

    def __init__(self, cursor: str) -> None:
        super().__init__(
            f"pagination did not advance: cursor {cursor!r} came back twice"
        )
        self.cursor = cursor


class ResponseTooLargeError(ValueError):
    """A buffered binary response exceeded its retained-byte limit.

    Args:
        limit (int): the maximum bytes the read was allowed to retain.
    """

    def __init__(self, limit: int) -> None:
        super().__init__(f"API response body exceeds {limit} bytes")
        self.limit = limit
