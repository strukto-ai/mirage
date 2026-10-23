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

from collections.abc import Awaitable, Callable

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from mirage.vfs.constants import FULL_SCAN_LIMIT

EmbedFn = Callable[[str], Awaitable[list[float]]]


class QdrantConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    url: str | None = None
    """Full URL of the Qdrant server, such as a Qdrant Cloud cluster URL;
    when set, `host`, `port` and `https` are ignored."""
    host: str = "localhost"
    """Host name of the Qdrant server when `url` is unset."""
    port: int = 6333
    """Port of the Qdrant server when `url` is unset."""
    https: bool = False
    """Connect to `host` over HTTPS when `url` is unset."""
    api_key: SecretStr | None = None
    """Qdrant API key, required by Qdrant Cloud."""
    collection: str | None = None
    """Collection the mount root shows; unset lists every collection as a
    top-level folder."""
    group_by: list[str] = []
    """Payload fields that become folder levels, one per field in order;
    dotted paths reach nested keys. Unset puts every point's files directly
    under the collection."""
    basename_fields: list[str] = []
    """`group_by` fields whose folder names keep only the last path or URL
    segment of the value; two values with one basename under the same
    parent are refused as a collision."""
    id_field: str = "id"
    """Key the point id is written under in a point's `.json`; it replaces a
    payload field of that name."""
    name_field: str | None = None
    """Payload field whose value prefixes each point's file stem as
    `<name>__<id>`; unset names files by point id alone."""
    text_field: str | None = None
    """Payload field served as the point's `.txt` file and printed by
    `search`; unset leaves no `.txt`, and `search` returns the `.json`."""
    blob_field: str | None = None
    """Payload field of raw or base64 bytes served as `<id>.<blob_ext>` and
    left out of the `.json`; unset adds no blob file."""
    blob_ext: str = "bin"
    """File extension of the blob file, without the dot."""
    vector_field: str | None = None
    """Payload field holding a copy of the vector, left out of the
    `.json`."""
    search_limit: int = 10
    """Results `search` returns when `--top-k` is not given."""
    max_rows: int = 1000
    """Most points one folder listing scrolls; points past it are left
    out, and a group folder lists only the values those points carry."""
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    """Model the server embeds a `search` query with under
    `cloud_inference`; it must match the model the stored vectors came
    from."""
    cloud_inference: bool = False
    """Send the `search` query text to the server to embed, which needs a
    cluster with inference enabled (Qdrant Cloud). `embed` takes
    precedence; with neither, `search` refuses the query."""
    embed: EmbedFn | None = None
    """Async function that turns a `search` query into a vector in-process,
    `(text: str) -> list[float]`."""
    full_scan_limit: int = Field(default=FULL_SCAN_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit."""
