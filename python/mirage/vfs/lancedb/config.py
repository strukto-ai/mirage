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


class LanceDBConfig(BaseModel):
    uri: str
    api_key: SecretStr | None = None
    region: str = "us-east-1"
    host_override: str | None = None
    storage_options: dict[str, str] | None = None
    table: str | None = None
    group_by: list[str] = []
    id_column: str = "id"
    title_column: str | None = None
    blob_column: str | None = None
    blob_ext: str = "bin"
    text_column: str | None = None
    vector_column: str | None = None
    search_limit: int = 10
    max_rows: int = 1000
