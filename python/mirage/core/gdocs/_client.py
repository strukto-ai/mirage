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

from mirage.core.google._client import DOCS_API_BASE  # noqa: F401
from mirage.core.google._client import (DRIVE_API_BASE, TOKEN_BUFFER_SECONDS,
                                        TOKEN_URL, TokenManager, docs_base,
                                        drive_base, google_get,
                                        google_get_bytes, google_headers,
                                        google_post, google_put,
                                        refresh_access_token)

__all__ = [
    "DOCS_API_BASE",
    "DRIVE_API_BASE",
    "TOKEN_URL",
    "TOKEN_BUFFER_SECONDS",
    "TokenManager",
    "docs_base",
    "drive_base",
    "google_get",
    "google_get_bytes",
    "google_headers",
    "google_post",
    "google_put",
    "refresh_access_token",
]
