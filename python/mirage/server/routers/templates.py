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

from mirage.resources.errors import ResourceError, ResourceErrorCode
from mirage.resources.types import Template, TemplateInput
from mirage.server.errors import ErrorCode, HttpError
from mirage.server.schemas import (
    CreateTemplateRequest,
    TemplateList,
    TemplateResponse,
)

CODE: dict[ResourceErrorCode, ErrorCode] = {
    "not_found": ErrorCode.NOT_FOUND,
    "conflict": ErrorCode.CONFLICT,
    "invalid": ErrorCode.INVALID_REQUEST,
}

# Every workspace made from a template would claim one id, which a worker
# proxy cannot see without reading the template; the create names it.
NO_WORKSPACE_ID = (
    "a template's config cannot set workspace_id; give the id when you "
    "create from it"
)


def require_one_account(request: Request) -> None:
    """Refuse templates on a server of many accounts: its one store would
    let each account read and use the others'.

    Args:
        request (Request): the HTTP request, for the app's registry.

    Raises:
        HttpError: 501 while the server requires accounts.
    """
    if request.app.state.registry.accounts_required:
        raise HttpError(
            ErrorCode.NOT_SUPPORTED,
            "templates are kept only on a server of one account",
        )


router = APIRouter(
    prefix="/v1/templates", dependencies=[Depends(require_one_account)]
)


def store_refusal(e: ResourceError) -> HttpError:
    """The answer for a store's refusal, by its code.

    Args:
        e (ResourceError): what the store raised.
    """
    return HttpError(CODE[e.code], str(e))


def present(template: Template) -> TemplateResponse:
    return TemplateResponse(
        name=template.name,
        description=template.description,
        config=template.config,
    )


@router.get("", response_model=TemplateList)
async def list_templates(request: Request) -> TemplateList:
    """The saved templates, by name."""
    try:
        templates = await request.app.state.resources.list_templates()
    except ResourceError as e:
        raise store_refusal(e) from e
    return TemplateList(items=[present(t) for t in templates])


@router.post("", response_model=TemplateResponse, status_code=201)
async def create_template(
    req: CreateTemplateRequest, request: Request
) -> TemplateResponse:
    """Save a template: a whole workspace config, checked as a create
    checks one, and kept as written. A name already saved is a 409.

    Args:
        req (CreateTemplateRequest): the name, description and config.
        request (Request): the HTTP request, for the app's store.
    """
    if req.config.workspace_id is not None:
        raise HttpError(ErrorCode.INVALID_REQUEST, NO_WORKSPACE_ID)
    written = (await request.json())["config"]
    try:
        saved = await request.app.state.resources.create_template(
            TemplateInput(
                name=req.name, description=req.description, config=written
            )
        )
    except ResourceError as e:
        raise store_refusal(e) from e
    return present(saved)


@router.get("/{ref}", response_model=TemplateResponse)
async def get_template(ref: str, request: Request) -> TemplateResponse:
    try:
        return present(await request.app.state.resources.get_template(ref))
    except ResourceError as e:
        raise store_refusal(e) from e


@router.delete("/{ref}", status_code=204)
async def delete_template(ref: str, request: Request) -> Response:
    """Delete a template; ``restore`` brings it back.

    Args:
        ref (str): the template's name.
        request (Request): the HTTP request, for the app's store.
    """
    try:
        await request.app.state.resources.delete_template(ref)
    except ResourceError as e:
        raise store_refusal(e) from e
    return Response(status_code=204)


@router.post("/{ref}/restore", response_model=TemplateResponse)
async def restore_template(ref: str, request: Request) -> TemplateResponse:
    try:
        return present(await request.app.state.resources.restore_template(ref))
    except ResourceError as e:
        raise store_refusal(e) from e
