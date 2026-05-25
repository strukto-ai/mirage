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

from pydantic import BaseModel, ConfigDict


class CommitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    branch: str = "main"
    message: str = ""


class CommitResponse(BaseModel):
    version: str
    branch: str


class VersionLogItem(BaseModel):
    id: str
    message: str


class CheckoutRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ref: str


class CloneRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_id: str
    at: str | None = None
    id: str | None = None


class DiffResponse(BaseModel):
    added: list[str]
    modified: list[str]
    deleted: list[str]


class BranchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    from_branch: str = "main"


class BranchResponse(BaseModel):
    branch: str
    version: str
