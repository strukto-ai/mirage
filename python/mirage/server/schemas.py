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
    vfs: str
    mode: str
    description: str = ""


class SessionSummary(BaseModel):
    session_id: str
    cwd: str


class HealthResponse(BaseModel):
    status: str = "ok"
    workspaces: int
    uptime_s: float


class WorkspaceInternals(BaseModel):
    cache_bytes: int | None
    cache_entries: int | None
    history_length: int
    in_flight_jobs: int


class WorkspaceBrief(BaseModel):
    id: str
    mode: str
    mount_count: int
    session_count: int
    created_at: float


class WorkspaceDetail(BaseModel):
    id: str
    mode: str
    created_at: float
    fuse_mountpoints: dict[str, str] = Field(default_factory=dict)
    system_time: str | None = None
    sessions: list[SessionSummary] = Field(default_factory=list)
    mounts: list[MountSummary] = Field(default_factory=list)
    internals: WorkspaceInternals | None = None


class CreateWorkspaceRequest(BaseModel):
    """A workspace to create: from ``config``, or from the saved
    ``template`` of that name, never both."""

    model_config = ConfigDict(extra="forbid")

    config: WorkspaceConfig | None = None
    template: str | None = None
    id: str | None = None


def check_config(written: dict[str, Any]) -> WorkspaceConfig:
    """A workspace config checked as a create checks one.

    Args:
        written (dict[str, Any]): the config as written.

    Raises:
        ValidationError: naming what is wrong.
    """
    return WorkspaceConfig.model_validate(written)


class CreateTemplateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str | None = None
    config: WorkspaceConfig


class TemplateResponse(BaseModel):
    name: str
    description: str | None
    config: dict[str, Any]


class TemplateList(BaseModel):
    items: list[TemplateResponse]


class CloneWorkspaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str | None = None
    override: dict[str, Any] | None = None


class SnapshotWorkspaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str


class SnapshotWorkspaceResponse(BaseModel):
    id: str
    key: str
    size: int


class LoadWorkspaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str | None = None
    id: str | None = None
    override: dict[str, Any] | None = None


class DeleteWorkspaceResponse(BaseModel):
    id: str
    closed_at: float


class CancelLinesResponse(BaseModel):
    canceled: int


class KillJobsResponse(BaseModel):
    killed: int
