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

from tests.fixtures.google_account import google_account
from tests.fixtures.graph_drive import onedrive, sharepoint
from tests.fixtures.hf_bucket import bucket
from tests.fixtures.hub_repo import hub
from tests.fixtures.slack_workspace import slack_workspace

__all__ = [
    "bucket",
    "google_account",
    "hub",
    "onedrive",
    "sharepoint",
    "slack_workspace",
]
