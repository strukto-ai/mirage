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

# yapf: disable
from mirage.core.google._client import (DOCS_API_BASE, DRIVE_API_BASE,
                                        DRIVE_UPLOAD_BASE, GMAIL_API_BASE,
                                        SHEETS_API_BASE, SLIDES_API_BASE,
                                        TOKEN_URL, TokenManager, docs_base,
                                        drive_base, drive_upload_base,
                                        gmail_base, sheets_base, slides_base,
                                        token_url)
# yapf: enable
from mirage.core.google.config import GoogleConfig


def _manager() -> TokenManager:
    return TokenManager(GoogleConfig(client_id="cid", refresh_token="rt"))


def test_bases_default_to_real_google_hosts():
    tm = _manager()
    assert drive_base(tm) == DRIVE_API_BASE
    assert drive_upload_base(tm) == DRIVE_UPLOAD_BASE
    assert docs_base(tm) == DOCS_API_BASE
    assert slides_base(tm) == SLIDES_API_BASE
    assert sheets_base(tm) == SHEETS_API_BASE
    assert gmail_base(tm) == GMAIL_API_BASE
    assert token_url() == TOKEN_URL
