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

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from mirage.server.auth.config import PROTECTED_RESOURCE_PATH

router = APIRouter()


class ProtectedResource(BaseModel):
    resource: str
    authorization_servers: list[str]
    bearer_methods_supported: list[str]
    client_id: str


@router.get(PROTECTED_RESOURCE_PATH, response_model=ProtectedResource)
async def protected_resource(request: Request) -> ProtectedResource:
    """Say where to log in, for ``mirage login``.

    RFC 9728's protected resource metadata names the issuer, and
    ``client_id`` the OAuth client the CLI signs in as. A server that
    publishes no login answers 404, so the CLI knows it needs none.
    """
    jwt = request.app.state.auth_config.jwt
    if jwt is None or jwt.login_client_id is None or jwt.issuer is None:
        raise HTTPException(
            status_code=404, detail="this server publishes no login"
        )
    return ProtectedResource(
        resource=str(request.base_url).rstrip("/"),
        authorization_servers=[jwt.issuer],
        bearer_methods_supported=["header"],
        client_id=jwt.login_client_id,
    )
