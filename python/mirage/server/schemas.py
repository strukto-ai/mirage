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

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from mirage.config import WorkspaceConfig
from mirage.types import MountBackend


class MountSummary(BaseModel):
    prefix: str
    vfs: str
    mode: str
    description: str = ""
    backend: MountBackend = MountBackend.WORKSPACE
    mountpoint: str | None = None


class SessionSummary(BaseModel):
    session_id: str
    cwd: str


class HealthResponse(BaseModel):
    status: str = "ok"
    workspaces: int
    uptime_ms: int


class WorkspaceInternals(BaseModel):
    cache_bytes: int | None
    cache_entries: int | None
    history_length: int
    in_flight_jobs: int


# Running while the server holds it in memory; stopped while only its
# config and state are kept.
WorkspaceStatus = Literal["running", "stopped"]


# An instant as the API reports every time: RFC 3339 in UTC to the
# millisecond, from ``ms_to_rfc3339``.
Instant = Annotated[str, Field(json_schema_extra={"format": "date-time"})]


class WorkspaceBrief(BaseModel):
    id: str
    status: WorkspaceStatus
    created_at: Instant


class WorkspaceList(BaseModel):
    items: list[WorkspaceBrief]


class WorkspaceDetail(BaseModel):
    id: str
    status: WorkspaceStatus
    created_at: Instant
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


class StopWorkspaceResponse(BaseModel):
    id: str
    stopped_at: Instant


class CancelLinesResponse(BaseModel):
    canceled: int


class KillJobsResponse(BaseModel):
    killed: int
