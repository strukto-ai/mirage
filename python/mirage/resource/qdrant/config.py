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


class QdrantConfig(BaseModel):
    url: str | None = None
    host: str = "localhost"
    port: int = 6333
    https: bool = False
    api_key: SecretStr | None = None
    collection: str | None = None
    group_by: list[str] = []
    id_field: str = "id"
    text_field: str | None = None
    blob_field: str | None = None
    blob_ext: str = "bin"
    vector_field: str | None = None
    search_limit: int = 10
    max_rows: int = 1000
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    cloud_inference: bool = False
