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

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from mirage.vfs.constants import WALK_LIMIT


class LanceDBConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    uri: str
    """Database location: a local directory, an `s3://`, `gs://` or `az://`
    URI, or a `db://` URI for LanceDB Cloud or Enterprise."""
    api_key: SecretStr | None = None
    """API key for LanceDB Cloud or Enterprise."""
    region: str = "us-east-1"
    """LanceDB Cloud region of a `db://` database; ignored for other URIs."""
    host_override: str | None = None
    """Endpoint of a LanceDB Enterprise deployment for a `db://` URI;
    ignored for other URIs."""
    storage_options: dict[str, str] | None = None
    """Options passed to LanceDB's object-store layer, such as credentials
    or an endpoint for an `s3://` URI."""
    table: str | None = None
    """Table the mount root shows; unset lists every table as a top-level
    folder."""
    group_by: list[str] = []
    """Columns that become folder levels, one per column in order; unset
    puts every row's files directly under the table."""
    id_column: str = "id"
    """Column whose value names each row's files (`<id>.md`,
    `<id>.<blob_ext>`)."""
    title_column: str | None = None
    """Column whose value heads a row's card as a `# ` title; unset leaves
    the card without one."""
    blob_column: str | None = None
    """Column of raw or base64 bytes served as `<id>.<blob_ext>` and left
    out of the card; unset adds no blob file."""
    blob_ext: str = "bin"
    """File extension of the blob file, without the dot."""
    vector_column: str | None = None
    """Embedding column left out of cards and listings."""
    search_limit: int = 10
    """Results `search` returns when `--top-k` is not given."""
    max_rows: int = 1000
    """Most rows one folder listing reads; rows past it are left out, and a
    group folder lists only the values those rows carry."""
    walk_limit: int = Field(default=WALK_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit."""
