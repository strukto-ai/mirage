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

import aiohttp

from mirage.resource.secrets import reveal_secret
from mirage.resource.trello.config import TrelloConfig
from mirage.types import PathSpec


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


async def _request(
    config: TrelloConfig,
    method: str,
    path: PathSpec,
    *,
    params: dict | None = None,
    json_body: dict | None = None,
) -> dict | list:
    url = f"{config.base_url}{path}"
    merged = {**_auth_params(config), **(params or {})}
    async with aiohttp.ClientSession() as session:
        async with session.request(
                method,
                url,
                params=merged,
                json=json_body,
        ) as resp:
            if resp.status >= 400:
                text = await resp.text()
                raise TrelloAPIError(
                    f"Trello API error: HTTP {resp.status}: {text}",
                    status=resp.status,
                )
            return await resp.json()


async def _get(
    config: TrelloConfig,
    path: PathSpec,
    params: dict | None = None,
) -> dict | list:
    return await _request(config, "GET", path, params=params)


async def _post(
    config: TrelloConfig,
    path: PathSpec,
    params: dict | None = None,
) -> dict | list:
    return await _request(config, "POST", path, params=params)


async def _put(
    config: TrelloConfig,
    path: PathSpec,
    params: dict | None = None,
) -> dict | list:
    return await _request(config, "PUT", path, params=params)


async def _delete(
    config: TrelloConfig,
    path: PathSpec,
    params: dict | None = None,
) -> dict | list:
    return await _request(config, "DELETE", path, params=params)


async def list_workspaces(config: TrelloConfig) -> list[dict]:
    result = await _get(config, "/members/me/organizations")
    return result if isinstance(result, list) else []


async def list_workspace_boards(
    config: TrelloConfig,
    workspace_id: str,
) -> list[dict]:
    result = await _get(
        config,
        f"/organizations/{workspace_id}/boards",
        params={"filter": "open"},
    )
    return result if isinstance(result, list) else []


async def get_board(config: TrelloConfig, board_id: str) -> dict:
    result = await _get(config, f"/boards/{board_id}")
    if not isinstance(result, dict):
        raise TrelloAPIError(f"unexpected response for board {board_id}")
    return result


async def list_board_lists(
    config: TrelloConfig,
    board_id: str,
) -> list[dict]:
    result = await _get(
        config,
        f"/boards/{board_id}/lists",
        params={"filter": "open"},
    )
    return result if isinstance(result, list) else []


async def list_board_members(
    config: TrelloConfig,
    board_id: str,
) -> list[dict]:
    result = await _get(config, f"/boards/{board_id}/members")
    return result if isinstance(result, list) else []


async def list_board_labels(
    config: TrelloConfig,
    board_id: str,
) -> list[dict]:
    result = await _get(config, f"/boards/{board_id}/labels")
    return result if isinstance(result, list) else []


async def list_list_cards(
    config: TrelloConfig,
    list_id: str,
) -> list[dict]:
    result = await _get(
        config,
        f"/lists/{list_id}/cards",
        params={
            "members": "true",
            "member_fields": "id,username,fullName",
        },
    )
    return result if isinstance(result, list) else []


async def get_card(config: TrelloConfig, card_id: str) -> dict:
    result = await _get(
        config,
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
    config: TrelloConfig,
    card_id: str,
) -> list[dict]:
    result = await _get(
        config,
        f"/cards/{card_id}/actions",
        params={"filter": "commentCard"},
    )
    return result if isinstance(result, list) else []


async def card_create(
    config: TrelloConfig,
    *,
    list_id: str,
    name: str,
    desc: str | None = None,
) -> dict:
    params: dict[str, str] = {"idList": list_id, "name": name}
    if desc:
        params["desc"] = desc
    result = await _post(config, "/cards", params=params)
    if not isinstance(result, dict):
        raise TrelloAPIError("unexpected response from card create")
    return await get_card(config, result["id"])


async def card_update(
    config: TrelloConfig,
    *,
    card_id: str,
    name: str | None = None,
    desc: str | None = None,
    closed: bool | None = None,
    due: str | None = None,
    due_complete: bool | None = None,
) -> dict:
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
    await _put(config, f"/cards/{card_id}", params=params)
    return await get_card(config, card_id)


async def card_move(
    config: TrelloConfig,
    *,
    card_id: str,
    list_id: str,
) -> dict:
    await _put(config, f"/cards/{card_id}", params={"idList": list_id})
    return await get_card(config, card_id)


async def card_assign(
    config: TrelloConfig,
    *,
    card_id: str,
    member_id: str,
) -> dict:
    await _post(
        config,
        f"/cards/{card_id}/idMembers",
        params={"value": member_id},
    )
    return await get_card(config, card_id)


async def comment_create(
    config: TrelloConfig,
    *,
    card_id: str,
    text: str,
) -> dict:
    result = await _post(
        config,
        f"/cards/{card_id}/actions/comments",
        params={"text": text},
    )
    if not isinstance(result, dict):
        raise TrelloAPIError("unexpected response from comment create")
    return result


async def comment_update(
    config: TrelloConfig,
    *,
    card_id: str,
    comment_id: str,
    text: str,
) -> dict:
    result = await _put(
        config,
        f"/cards/{card_id}/actions/{comment_id}/comments",
        params={"text": text},
    )
    if not isinstance(result, dict):
        raise TrelloAPIError("unexpected response from comment update")
    return result


async def card_add_label(
    config: TrelloConfig,
    *,
    card_id: str,
    label_id: str,
) -> dict:
    await _post(
        config,
        f"/cards/{card_id}/idLabels",
        params={"value": label_id},
    )
    return await get_card(config, card_id)


async def card_remove_label(
    config: TrelloConfig,
    *,
    card_id: str,
    label_id: str,
) -> dict:
    await _delete(config, f"/cards/{card_id}/idLabels/{label_id}")
    return await get_card(config, card_id)
