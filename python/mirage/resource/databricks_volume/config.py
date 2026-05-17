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

from pydantic import BaseModel, ConfigDict, Field, field_validator


class DatabricksVolumeConfig(BaseModel):
    model_config = ConfigDict(frozen=True, populate_by_name=True)

    catalog: str
    schema_name: str = Field(alias="schema")
    volume: str
    host: str | None = None
    token: str | None = None

    @property
    def schema(self) -> str:
        return self.schema_name

    @field_validator("catalog", "schema_name", "volume")
    @classmethod
    def _validate_path_component(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError(
                "Databricks volume path components cannot be empty")
        if "/" in value or "\\" in value:
            raise ValueError(
                "Databricks volume path components cannot contain slashes")
        return value
