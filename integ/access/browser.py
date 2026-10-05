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
"""The browser ``mirage login`` opens, as ``$BROWSER``: a user already
signed in to the issuer, so it only follows the redirects back to the
CLI. Exits 0 when the CLI's page came back."""

import sys

import httpx

sys.exit(
    0
    if httpx.get(sys.argv[1], follow_redirects=True, timeout=30).is_success
    else 1
)
