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

from mirage.core.google._client import (DOCS_API_BASE, DRIVE_API_BASE,
                                        DRIVE_UPLOAD_BASE, SHEETS_API_BASE,
                                        SLIDES_API_BASE, TOKEN_URL,
                                        TokenManager, docs_base, drive_base,
                                        drive_upload_base, sheets_base,
                                        slides_base, token_url)
from mirage.core.google.config import GoogleConfig


def _manager(api_base: str | None = None) -> TokenManager:
    return TokenManager(
        GoogleConfig(client_id="cid", refresh_token="rt", api_base=api_base))


def test_bases_default_to_real_google_hosts():
    tm = _manager()
    assert drive_base(tm) == DRIVE_API_BASE
    assert drive_upload_base(tm) == DRIVE_UPLOAD_BASE
    assert docs_base(tm) == DOCS_API_BASE
    assert slides_base(tm) == SLIDES_API_BASE
    assert sheets_base(tm) == SHEETS_API_BASE
    assert token_url(tm.config) == TOKEN_URL


def test_api_base_override_rewrites_every_service():
    tm = _manager("http://127.0.0.1:19999")
    assert drive_base(tm) == "http://127.0.0.1:19999/drive/v3"
    assert drive_upload_base(tm) == "http://127.0.0.1:19999/upload/drive/v3"
    assert docs_base(tm) == "http://127.0.0.1:19999/v1"
    assert slides_base(tm) == "http://127.0.0.1:19999/v1"
    assert sheets_base(tm) == "http://127.0.0.1:19999/v4"
    assert token_url(tm.config) == "http://127.0.0.1:19999/token"
