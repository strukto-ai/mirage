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
    assert gmail_base(tm) == GMAIL_API_BASE
    assert token_url(tm.config) == TOKEN_URL


def test_api_base_override_rewrites_every_service():
    tm = _manager("http://127.0.0.1:19999")
    assert drive_base(tm) == "http://127.0.0.1:19999/drive/v3"
    assert drive_upload_base(tm) == "http://127.0.0.1:19999/upload/drive/v3"
    assert docs_base(tm) == "http://127.0.0.1:19999/v1"
    assert slides_base(tm) == "http://127.0.0.1:19999/v1"
    assert sheets_base(tm) == "http://127.0.0.1:19999/v4"
    assert gmail_base(tm) == "http://127.0.0.1:19999/gmail/v1"
    assert token_url(tm.config) == "http://127.0.0.1:19999/token"


def test_per_service_base_overrides_take_precedence_over_api_base():
    # each per-service base is the full service base and wins over api_base.
    tm = TokenManager(
        GoogleConfig(client_id="cid",
                     refresh_token="rt",
                     api_base="http://shared:9",
                     token_url="http://oauth:1/oauth2/token",
                     drive_api_base="http://drive:2/drive/v3",
                     drive_upload_api_base="http://drive:2/upload/drive/v3",
                     docs_api_base="http://docs:3/docs/v1",
                     sheets_api_base="http://sheets:4/sheets/v4",
                     slides_api_base="http://slides:5/slides/v1",
                     gmail_api_base="http://gmail:6/gmail/v1"))
    assert token_url(tm.config) == "http://oauth:1/oauth2/token"
    assert drive_base(tm) == "http://drive:2/drive/v3"
    assert drive_upload_base(tm) == "http://drive:2/upload/drive/v3"
    assert docs_base(tm) == "http://docs:3/docs/v1"
    assert sheets_base(tm) == "http://sheets:4/sheets/v4"
    assert slides_base(tm) == "http://slides:5/slides/v1"
    assert gmail_base(tm) == "http://gmail:6/gmail/v1"


def test_per_service_base_falls_back_to_api_base_then_real_default():
    # one per-service override set; the rest fall back to api_base, and with no
    # api_base they fall back to the real Google hosts.
    tm = TokenManager(
        GoogleConfig(client_id="cid",
                     refresh_token="rt",
                     api_base="http://m",
                     docs_api_base="http://docs-only/docs/v1"))
    assert docs_base(tm) == "http://docs-only/docs/v1"  # explicit
    assert sheets_base(tm) == "http://m/v4"  # api_base derived
    assert gmail_base(tm) == "http://m/gmail/v1"  # api_base derived
    bare = TokenManager(GoogleConfig(client_id="cid", refresh_token="rt"))
    assert sheets_base(bare) == SHEETS_API_BASE  # real default
    assert token_url(bare.config) == TOKEN_URL
