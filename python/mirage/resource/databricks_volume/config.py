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

import posixpath

from pydantic import BaseModel, ConfigDict, Field, field_validator


class DatabricksVolumeConfig(BaseModel):
    model_config = ConfigDict(frozen=True,
                              populate_by_name=True,
                              serialize_by_alias=True)

    catalog: str
    # Public config key is still "schema"
    # internal name avoids warning overwriting BaseModel.schema.
    schema_name: str = Field(alias="schema")
    volume: str
    root_path: str = "/"
    host: str | None = None
    token: str | None = None
    profile: str | None = None
    timeout: int = 30

    @field_validator("catalog", "schema_name", "volume")
    @classmethod
    def validate_volume_part(cls, value: str) -> str:
        if not value or "/" in value:
            raise ValueError("must be a non-empty path segment")
        return value

    @field_validator("root_path")
    @classmethod
    def normalize_root_path(cls, value: str) -> str:
        stripped = value.strip("/")
        if not stripped:
            return "/"
        if any(part == ".." for part in stripped.split("/")):
            raise ValueError("root_path must not contain '..' segments")
        normalized = posixpath.normpath("/" + stripped)
        return "/" if normalized == "/." else normalized
