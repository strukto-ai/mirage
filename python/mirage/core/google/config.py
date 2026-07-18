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


class GoogleConfig(BaseModel):
    client_id: str
    client_secret: SecretStr | None = None
    refresh_token: SecretStr
    # Single-host override for every Google API (drive/docs/sheets/slides)
    # plus the OAuth token endpoint; used to point backends at a fake server.
    api_base: str | None = None
    # Drive-only: scope the mount to this folder ID instead of the Drive
    # root, the s3 key_prefix analog. Other Google backends ignore it.
    folder_id: str | None = None
