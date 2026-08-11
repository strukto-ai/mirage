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

from pydantic import BaseModel, SecretStr


class NotionConfig(BaseModel):
    api_key: SecretStr
    base_url: str = "https://api.notion.com/v1"
    # None means the generation the client is written against. A CLI
    # verb overrides it per line from --notion-version, so the override
    # travels with the config the transport already takes rather than as
    # a second argument every call site would have to thread.
    api_version: str | None = None
