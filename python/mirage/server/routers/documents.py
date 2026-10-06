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

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict

from mirage.policy.errors import PolicyError

router = APIRouter(prefix="/v1/workspaces")


class DocumentPath(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str


async def document(
    request: Request,
    workspace_id: str,
    kind: Literal["vfs", "skill"],
    path: str | None,
    session_id: str | None,
    profile: str | None,
) -> Response:
    entry = request.app.state.registry.visible(
        workspace_id, request.state.account
    )
    if entry is None:
        raise HTTPException(404, "workspace not found")
    # Loaded before the error mapping: a store that cannot be read is
    # the server's failure, never a 403 or 404 to the client.
    await entry.runner.call(entry.runner.ws.ensure_sessions_loaded())
    method = (
        entry.runner.ws.vfs_md if kind == "vfs" else entry.runner.ws.skill_md
    )
    try:
        content = await entry.runner.call(
            method(path, session_id=session_id, profile=profile)
        )
    except KeyError as exc:
        raise HTTPException(404, "session not found") from exc
    except (ValueError, PolicyError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except OSError as exc:
        status = next(
            (
                status
                for cls, status in (
                    (FileNotFoundError, 404),
                    (FileExistsError, 409),
                    (NotADirectoryError, 422),
                    (PermissionError, 403),
                )
                if isinstance(exc, cls)
            ),
            None,
        )
        if status is None:
            raise
        raise HTTPException(status, str(exc)) from exc
    return Response(content, media_type="text/markdown")


def _register(kind: Literal["vfs", "skill"]) -> None:
    """Add one document's GET and PUT routes, workspace and session.

    Args:
        kind (Literal["vfs", "skill"]): the document the routes serve.
    """

    async def get(
        workspace_id: str,
        request: Request,
        session_id: str | None = None,
        profile: str | None = None,
    ) -> Response:
        return await document(
            request, workspace_id, kind, None, session_id, profile
        )

    async def put(
        workspace_id: str,
        body: DocumentPath,
        request: Request,
        session_id: str | None = None,
        profile: str | None = None,
    ) -> Response:
        return await document(
            request, workspace_id, kind, body.path, session_id, profile
        )

    for base in ("/{workspace_id}", "/{workspace_id}/sessions/{session_id}"):
        router.add_api_route(f"{base}/{kind}-md", get, methods=["GET"])
        router.add_api_route(f"{base}/{kind}-md", put, methods=["PUT"])


_register("vfs")
_register("skill")
