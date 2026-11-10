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


from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict

from mirage.resources.constants import POLICY_NAME
from mirage.resources.errors import ResourceError
from mirage.resources.types import Policy
from mirage.server.errors import ErrorCode, HttpError
from mirage.server.routers.templates import store_refusal

# A policy is a script, not a project, so its source is at most 64 KiB.
MAX_SOURCE = 64 * 1024


class CreatePolicyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    source: str


class UpdatePolicyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str


class PolicyResponse(BaseModel):
    name: str
    source: str


class PolicyName(BaseModel):
    name: str


class PolicyList(BaseModel):
    items: list[PolicyName]


def require_one_account(request: Request) -> None:
    """Refuse policies on a server of many accounts: its one store would
    let each account read and change the others'.

    Args:
        request (Request): the HTTP request, for the app's registry.

    Raises:
        HttpError: 501 while the server requires accounts.
    """
    if request.app.state.registry.accounts_required:
        raise HttpError(
            ErrorCode.NOT_SUPPORTED,
            "policies are kept only on a server of one account",
        )


router = APIRouter(
    prefix="/v1/policies", dependencies=[Depends(require_one_account)]
)


def check_source(source: str) -> str:
    """Refuse a source over 64 KiB.

    Args:
        source (str): the policy's program.

    Raises:
        HttpError: 400 past 64 KiB of UTF-8.
    """
    if len(source.encode()) > MAX_SOURCE:
        raise HttpError(
            ErrorCode.INVALID_VALUE,
            f"source must be at most {MAX_SOURCE // 1024} KB",
            param="source",
        )
    return source


def present(policy: Policy) -> PolicyResponse:
    return PolicyResponse(name=policy.name, source=policy.source)


@router.get("", response_model=PolicyList)
async def list_policies(request: Request) -> PolicyList:
    """The saved policies' names, sorted; ``GET /:ref`` has a source."""
    try:
        policies = await request.app.state.resources.list_policies()
    except ResourceError as e:
        raise store_refusal(e) from e
    return PolicyList(items=[PolicyName(name=p.name) for p in policies])


@router.post("", response_model=PolicyResponse, status_code=201)
async def create_policy(
    req: CreatePolicyRequest, request: Request
) -> PolicyResponse:
    """Save a new policy. A name already saved is a 409.

    Args:
        req (CreatePolicyRequest): the name and source.
        request (Request): the HTTP request, for the app's store.
    """
    if POLICY_NAME.fullmatch(req.name) is None:
        raise HttpError(
            ErrorCode.INVALID_VALUE,
            "name must end in .py, such as guard.py",
            param="name",
        )
    source = check_source(req.source)
    try:
        saved = await request.app.state.resources.create_policy(
            Policy(name=req.name, source=source)
        )
    except ResourceError as e:
        raise store_refusal(e) from e
    return present(saved)


@router.get("/{ref}", response_model=PolicyResponse)
async def get_policy(ref: str, request: Request) -> PolicyResponse:
    try:
        return present(await request.app.state.resources.get_policy(ref))
    except ResourceError as e:
        raise store_refusal(e) from e


@router.put("/{ref}", response_model=PolicyResponse)
async def update_policy(
    ref: str, req: UpdatePolicyRequest, request: Request
) -> PolicyResponse:
    """Replace a saved policy's source; a missing one is a 404.

    Args:
        ref (str): the policy's name.
        req (UpdatePolicyRequest): the new source.
        request (Request): the HTTP request, for the app's store.
    """
    source = check_source(req.source)
    try:
        saved = await request.app.state.resources.update_policy(
            Policy(name=ref, source=source)
        )
    except ResourceError as e:
        raise store_refusal(e) from e
    return present(saved)


@router.delete("/{ref}", status_code=204)
async def delete_policy(ref: str, request: Request) -> Response:
    try:
        await request.app.state.resources.delete_policy(ref)
    except ResourceError as e:
        raise store_refusal(e) from e
    return Response(status_code=204)
