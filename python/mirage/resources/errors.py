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


from typing import Literal, TypeAlias

ResourceErrorCode: TypeAlias = Literal["not_found", "conflict", "invalid"]
"""What went wrong, which a route maps to its status: 404, 409 or 400."""


class ResourceError(Exception):
    """A store refused a call. Every backend raises the same code for the
    same case."""

    def __init__(self, code: ResourceErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: ResourceErrorCode = code
