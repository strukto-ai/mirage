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

from mirage.accessor.trello import TrelloAccessor
from mirage.core.api.client import api_request
from mirage.core.trello.config import TrelloConfig
from mirage.vfs.secrets import reveal_secret


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


def _error_of(
    resp: aiohttp.ClientResponse, text: str, *, path: str
) -> Exception:
    # The endpoint rides in the message the way TypeScript's
    # TrelloApiError carries it: an agent reading the failure needs to
    # know which call 404'd, not just that one did.
    return TrelloAPIError(
        f"Trello API error ({path}): HTTP {resp.status}: {text}",
        status=resp.status,
    )


async def _request(
    accessor: TrelloAccessor,
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
) -> dict[str, Any] | list[Any]:
    url = f"{accessor.config.base_url}{path}"
    merged = {**_auth_params(accessor.config), **(params or {})}
    data: dict[str, Any] | list[Any] = await api_request(
        method,
        url,
        error_of=partial(_error_of, path=path),
        params=merged,
        json_body=json_body,
        session=accessor.pool,
    )
    return data


async def _get(
    accessor: TrelloAccessor, path: str, params: dict[str, Any] | None = None
) -> dict[str, Any] | list[Any]:
    return await _request(accessor, "GET", path, params=params)


async def _post(
    accessor: TrelloAccessor, path: str, params: dict[str, Any] | None = None
) -> dict[str, Any] | list[Any]:
    return await _request(accessor, "POST", path, params=params)


async def _put(
    accessor: TrelloAccessor, path: str, params: dict[str, Any] | None = None
) -> dict[str, Any] | list[Any]:
    return await _request(accessor, "PUT", path, params=params)


async def _delete(
    accessor: TrelloAccessor, path: str, params: dict[str, Any] | None = None
) -> dict[str, Any] | list[Any]:
    return await _request(accessor, "DELETE", path, params=params)


async def list_workspaces(accessor: TrelloAccessor) -> list[dict[str, Any]]:
    result = await _get(accessor, "/members/me/organizations")
    return result if isinstance(result, list) else []


async def list_workspace_boards(
    accessor: TrelloAccessor, workspace_id: str
) -> list[dict[str, Any]]:
    result = await _get(
        accessor,
        f"/organizations/{workspace_id}/boards",
        params={"filter": "open"},
    )
    return result if isinstance(result, list) else []


async def get_board(accessor: TrelloAccessor, board_id: str) -> dict[str, Any]:
    result = await _get(accessor, f"/boards/{board_id}")
    if not isinstance(result, dict):
        raise TrelloAPIError(f"unexpected response for board {board_id}")
    return result


async def list_board_lists(
    accessor: TrelloAccessor, board_id: str
) -> list[dict[str, Any]]:
    result = await _get(
        accessor, f"/boards/{board_id}/lists", params={"filter": "open"}
    )
    return result if isinstance(result, list) else []


async def get_list(accessor: TrelloAccessor, list_id: str) -> dict[str, Any]:
    result = await _get(accessor, f"/lists/{list_id}")
    if not isinstance(result, dict):
        raise TrelloAPIError(f"unexpected response for list {list_id}")
    return result


async def list_board_members(
    accessor: TrelloAccessor, board_id: str
) -> list[dict[str, Any]]:
    result = await _get(accessor, f"/boards/{board_id}/members")
    return result if isinstance(result, list) else []


async def list_board_labels(
    accessor: TrelloAccessor, board_id: str
) -> list[dict[str, Any]]:
    result = await _get(accessor, f"/boards/{board_id}/labels")
    return result if isinstance(result, list) else []


async def list_list_cards(
    accessor: TrelloAccessor, list_id: str
) -> list[dict[str, Any]]:
    result = await _get(
        accessor,
        f"/lists/{list_id}/cards",
        params={
            "members": "true",
            "member_fields": "id,username,fullName",
        },
    )
    return result if isinstance(result, list) else []


async def search_cards(
    accessor: TrelloAccessor, query: str, limit: int
) -> list[dict[str, Any]]:
    """The cards Trello's search names for ``query``, ids only.

    Args:
        accessor (TrelloAccessor): the account.
        query (str): the words searched for.
        limit (int): the most cards answered.
    """
    result = await _get(
        accessor,
        "/search",
        params={
            "query": query,
            "modelTypes": "cards",
            "card_fields": "id",
            "cards_limit": limit,
            "partial": "false",
        },
    )
    cards = result.get("cards") if isinstance(result, dict) else None
    if not isinstance(cards, list) or not all(
        isinstance(card, dict) and isinstance(card.get("id"), str)
        for card in cards
    ):
        raise TrelloAPIError("unexpected response from search")
    return cards


async def get_card(accessor: TrelloAccessor, card_id: str) -> dict[str, Any]:
    result = await _get(
        accessor,
        f"/cards/{card_id}",
        params={
            "members": "true",
            "member_fields": "id,username,fullName",
        },
    )
    if not isinstance(result, dict):
        raise TrelloAPIError(f"unexpected response for card {card_id}")
    return result


async def list_card_comments(
    accessor: TrelloAccessor, card_id: str
) -> list[dict[str, Any]]:
    result = await _get(
        accessor, f"/cards/{card_id}/actions", params={"filter": "commentCard"}
    )
    return result if isinstance(result, list) else []


async def card_create(
    accessor: TrelloAccessor,
    *,
    list_id: str,
    name: str,
    desc: str | None = None,
) -> dict[str, Any]:
    params: dict[str, str] = {"idList": list_id, "name": name}
    if desc:
        params["desc"] = desc
    result = await _post(accessor, "/cards", params=params)
    if not isinstance(result, dict):
        raise TrelloAPIError("unexpected response from card create")
    return await get_card(accessor, result["id"])


async def card_update(
    accessor: TrelloAccessor,
    *,
    card_id: str,
    name: str | None = None,
    desc: str | None = None,
    closed: bool | None = None,
    due: str | None = None,
    due_complete: bool | None = None,
) -> dict[str, Any]:
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
    await _put(accessor, f"/cards/{card_id}", params=params)
    return await get_card(accessor, card_id)


async def card_move(
    accessor: TrelloAccessor, *, card_id: str, list_id: str
) -> dict[str, Any]:
    await _put(accessor, f"/cards/{card_id}", params={"idList": list_id})
    return await get_card(accessor, card_id)


async def card_assign(
    accessor: TrelloAccessor, *, card_id: str, member_id: str
) -> dict[str, Any]:
    await _post(
        accessor, f"/cards/{card_id}/idMembers", params={"value": member_id}
    )
    return await get_card(accessor, card_id)


async def comment_create(
    accessor: TrelloAccessor, *, card_id: str, text: str
) -> dict[str, Any]:
    result = await _post(
        accessor, f"/cards/{card_id}/actions/comments", params={"text": text}
    )
    if not isinstance(result, dict):
        raise TrelloAPIError("unexpected response from comment create")
    return result


async def comment_update(
    accessor: TrelloAccessor, *, card_id: str, comment_id: str, text: str
) -> dict[str, Any]:
    result = await _put(
        accessor,
        f"/cards/{card_id}/actions/{comment_id}/comments",
        params={"text": text},
    )
    if not isinstance(result, dict):
        raise TrelloAPIError("unexpected response from comment update")
    return result


async def card_add_label(
    accessor: TrelloAccessor, *, card_id: str, label_id: str
) -> dict[str, Any]:
    await _post(
        accessor, f"/cards/{card_id}/idLabels", params={"value": label_id}
    )
    return await get_card(accessor, card_id)


async def card_remove_label(
    accessor: TrelloAccessor, *, card_id: str, label_id: str
) -> dict[str, Any]:
    await _delete(accessor, f"/cards/{card_id}/idLabels/{label_id}")
    return await get_card(accessor, card_id)
