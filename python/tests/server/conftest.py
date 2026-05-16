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

import pytest


@pytest.fixture(autouse=True)
def _allow_asgi_test_host(monkeypatch, request):
    # Existing server tests drive the app through httpx.ASGITransport
    # with base_url="http://test", which would otherwise be rejected
    # by the TrustedHostMiddleware installed in build_app(). Tests that
    # specifically exercise host validation opt out with the marker.
    if "no_host_override" in request.keywords:
        return
    monkeypatch.setenv("MIRAGE_ALLOWED_HOSTS", "*")
