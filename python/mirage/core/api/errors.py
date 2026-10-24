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
