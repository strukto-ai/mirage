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

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from mirage.config import WorkspaceConfig


class MountSummary(BaseModel):
    prefix: str
    resource: str
    mode: str
    description: str = ""


class WorkspaceBrief(BaseModel):
    id: str
    mode: str
    mount_count: int
    session_count: int
    created_at: float


class WorkspaceInternals(BaseModel):
    cache_bytes: int
    cache_entries: int
    history_length: int
    in_flight_jobs: int


class SessionSummary(BaseModel):
    session_id: str
    cwd: str


class WorkspaceDetail(BaseModel):
    id: str
    mode: str
    created_at: float
    sessions: list[SessionSummary] = Field(default_factory=list)
    mounts: list[MountSummary] = Field(default_factory=list)
    internals: WorkspaceInternals | None = None


class CreateWorkspaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    config: WorkspaceConfig
    id: str | None = None


class CloneWorkspaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str | None = None
    override: dict[str, Any] | None = None


class SnapshotWorkspaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str


class SnapshotWorkspaceResponse(BaseModel):
    id: str
    path: str
    size: int


class LoadWorkspaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str
    id: str | None = None
    override: dict[str, Any] | None = None


class DeleteWorkspaceResponse(BaseModel):
    id: str
    closed_at: float


class HealthResponse(BaseModel):
    status: str = "ok"
    workspaces: int
    uptime_s: float
