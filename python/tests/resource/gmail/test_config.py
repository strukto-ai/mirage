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

from mirage.resource.gmail.config import GmailConfig
from mirage.resource.secrets import reveal_secret


def test_config_creation():
    config = GmailConfig(
        client_id="xxx.apps.googleusercontent.com",
        client_secret="GOCSPx-xxx",
        refresh_token="1//0abc",
    )
    assert config.client_id == "xxx.apps.googleusercontent.com"
    assert reveal_secret(config.client_secret) == "GOCSPx-xxx"
    assert reveal_secret(config.refresh_token) == "1//0abc"
