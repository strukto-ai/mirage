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

from functools import partial
from typing import Any

import aiohttp

from mirage.core.api.client import SessionArg, api_request
from mirage.resource.secrets import reveal_secret
from mirage.resource.trello.config import TrelloConfig


class TrelloAPIError(RuntimeError):

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status


def _auth_params(config: TrelloConfig) -> dict[str, str]:
    return {
        "key": reveal_secret(config.api_key),
        "token": reveal_secret(config.api_token),
    }


def _error_of(resp: aiohttp.ClientResponse, text: str, *,
              path: str) -> Exception:
    # The endpoint rides in the message the way TypeScript's
    # TrelloApiError carries it: an agent reading the failure needs to
    # know which call 404'd, not just that one did.
    return TrelloAPIError(
        f"Trello API error ({path}): HTTP {resp.status}: {text}",
        status=resp.status,
    )


async def _request(config: TrelloConfig,
                   method: str,
                   path: str,
                   *,
                   params: dict[str, Any] | None = None,
                   json_body: dict[str, Any] | None = None,
                   session: SessionArg = None) -> dict[str, Any] | list[Any]:
    url = f"{config.base_url}{path}"
    merged = {**_auth_params(config), **(params or {})}
    data: dict[str, Any] | list[Any] = await api_request(method,
                                                         url,
                                                         error_of=partial(
                                                             _error_of,
                                                             path=path),
                                                         params=merged,
                                                         json_body=json_body,
                                                         session=session)
    return data


async def _get(config: TrelloConfig,
               path: str,
               params: dict[str, Any] | None = None,
               session: SessionArg = None) -> dict[str, Any] | list[Any]:
    return await _request(config, "GET", path, params=params, session=session)


async def _post(config: TrelloConfig,
                path: str,
                params: dict[str, Any] | None = None,
                session: SessionArg = None) -> dict[str, Any] | list[Any]:
    return await _request(config, "POST", path, params=params, session=session)


async def _put(config: TrelloConfig,
               path: str,
               params: dict[str, Any] | None = None,
               session: SessionArg = None) -> dict[str, Any] | list[Any]:
    return await _request(config, "PUT", path, params=params, session=session)


async def _delete(config: TrelloConfig,
                  path: str,
                  params: dict[str, Any] | None = None,
                  session: SessionArg = None) -> dict[str, Any] | list[Any]:
    return await _request(config,
                          "DELETE",
                          path,
                          params=params,
                          session=session)


async def list_workspaces(config: TrelloConfig,
                          session: SessionArg = None) -> list[dict[str, Any]]:
    result = await _get(config, "/members/me/organizations", session=session)
    return result if isinstance(result, list) else []


async def list_workspace_boards(
        config: TrelloConfig,
        workspace_id: str,
        session: SessionArg = None) -> list[dict[str, Any]]:
    result = await _get(config,
                        f"/organizations/{workspace_id}/boards",
                        params={"filter": "open"},
                        session=session)
    return result if isinstance(result, list) else []


async def get_board(config: TrelloConfig,
                    board_id: str,
                    session: SessionArg = None) -> dict[str, Any]:
    result = await _get(config, f"/boards/{board_id}", session=session)
    if not isinstance(result, dict):
        raise TrelloAPIError(f"unexpected response for board {board_id}")
    return result


async def list_board_lists(config: TrelloConfig,
                           board_id: str,
                           session: SessionArg = None) -> list[dict[str, Any]]:
    result = await _get(config,
                        f"/boards/{board_id}/lists",
                        params={"filter": "open"},
                        session=session)
    return result if isinstance(result, list) else []


async def list_board_members(
        config: TrelloConfig,
        board_id: str,
        session: SessionArg = None) -> list[dict[str, Any]]:
    result = await _get(config, f"/boards/{board_id}/members", session=session)
    return result if isinstance(result, list) else []


async def list_board_labels(
        config: TrelloConfig,
        board_id: str,
        session: SessionArg = None) -> list[dict[str, Any]]:
    result = await _get(config, f"/boards/{board_id}/labels", session=session)
    return result if isinstance(result, list) else []


async def list_list_cards(config: TrelloConfig,
                          list_id: str,
                          session: SessionArg = None) -> list[dict[str, Any]]:
    result = await _get(config,
                        f"/lists/{list_id}/cards",
                        params={
                            "members": "true",
                            "member_fields": "id,username,fullName",
                        },
                        session=session)
    return result if isinstance(result, list) else []


async def get_card(config: TrelloConfig,
                   card_id: str,
                   session: SessionArg = None) -> dict[str, Any]:
    result = await _get(config,
                        f"/cards/{card_id}",
                        params={
                            "members": "true",
                            "member_fields": "id,username,fullName",
                        },
                        session=session)
    if not isinstance(result, dict):
        raise TrelloAPIError(f"unexpected response for card {card_id}")
    return result


async def list_card_comments(
        config: TrelloConfig,
        card_id: str,
        session: SessionArg = None) -> list[dict[str, Any]]:
    result = await _get(config,
                        f"/cards/{card_id}/actions",
                        params={"filter": "commentCard"},
                        session=session)
    return result if isinstance(result, list) else []


async def card_create(config: TrelloConfig,
                      *,
                      list_id: str,
                      name: str,
                      desc: str | None = None,
                      session: SessionArg = None) -> dict[str, Any]:
    params: dict[str, str] = {"idList": list_id, "name": name}
    if desc:
        params["desc"] = desc
    result = await _post(config, "/cards", params=params, session=session)
    if not isinstance(result, dict):
        raise TrelloAPIError("unexpected response from card create")
    return await get_card(config, result["id"], session=session)


async def card_update(config: TrelloConfig,
                      *,
                      card_id: str,
                      name: str | None = None,
                      desc: str | None = None,
                      closed: bool | None = None,
                      due: str | None = None,
                      due_complete: bool | None = None,
                      session: SessionArg = None) -> dict[str, Any]:
    params: dict[str, str] = {}
    if name is not None:
        params["name"] = name
    if desc is not None:
        params["desc"] = desc
    if closed is not None:
        params["closed"] = str(closed).lower()
    if due is not None:
        params["due"] = due
    if due_complete is not None:
        params["dueComplete"] = str(due_complete).lower()
    if not params:
        raise ValueError("no updates provided")
    await _put(config, f"/cards/{card_id}", params=params, session=session)
    return await get_card(config, card_id, session=session)


async def card_move(config: TrelloConfig,
                    *,
                    card_id: str,
                    list_id: str,
                    session: SessionArg = None) -> dict[str, Any]:
    await _put(config,
               f"/cards/{card_id}",
               params={"idList": list_id},
               session=session)
    return await get_card(config, card_id, session=session)


async def card_assign(config: TrelloConfig,
                      *,
                      card_id: str,
                      member_id: str,
                      session: SessionArg = None) -> dict[str, Any]:
    await _post(config,
                f"/cards/{card_id}/idMembers",
                params={"value": member_id},
                session=session)
    return await get_card(config, card_id, session=session)


async def comment_create(config: TrelloConfig,
                         *,
                         card_id: str,
                         text: str,
                         session: SessionArg = None) -> dict[str, Any]:
    result = await _post(config,
                         f"/cards/{card_id}/actions/comments",
                         params={"text": text},
                         session=session)
    if not isinstance(result, dict):
        raise TrelloAPIError("unexpected response from comment create")
    return result


async def comment_update(config: TrelloConfig,
                         *,
                         card_id: str,
                         comment_id: str,
                         text: str,
                         session: SessionArg = None) -> dict[str, Any]:
    result = await _put(config,
                        f"/cards/{card_id}/actions/{comment_id}/comments",
                        params={"text": text},
                        session=session)
    if not isinstance(result, dict):
        raise TrelloAPIError("unexpected response from comment update")
    return result


async def card_add_label(config: TrelloConfig,
                         *,
                         card_id: str,
                         label_id: str,
                         session: SessionArg = None) -> dict[str, Any]:
    await _post(config,
                f"/cards/{card_id}/idLabels",
                params={"value": label_id},
                session=session)
    return await get_card(config, card_id, session=session)


async def card_remove_label(config: TrelloConfig,
                            *,
                            card_id: str,
                            label_id: str,
                            session: SessionArg = None) -> dict[str, Any]:
    await _delete(config,
                  f"/cards/{card_id}/idLabels/{label_id}",
                  session=session)
    return await get_card(config, card_id, session=session)
