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

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from aiohttp import web

FIXTURE = Path(
    __file__).resolve().parents[1] / "fixtures" / "trello" / "v1.json"
WRITE_STAMP = "2026-06-19T00:00:00.000Z"


class FakeTrello:

    def __init__(self) -> None:
        self.base = ""
        self.workspaces: list[dict[str, Any]] = []
        self.workspace_boards: dict[str, list[str]] = {}
        self.boards: dict[str, dict[str, Any]] = {}
        self.board_lists: dict[str, list[str]] = {}
        self.board_members: dict[str, list[dict[str, Any]]] = {}
        self.board_labels: dict[str, list[dict[str, Any]]] = {}
        self.labels_by_id: dict[str, dict[str, Any]] = {}
        self.members_by_id: dict[str, dict[str, Any]] = {}
        self.lists: dict[str, dict[str, Any]] = {}
        self.list_cards: dict[str, list[str]] = {}
        self.cards: dict[str, dict[str, Any]] = {}
        self.card_comments: dict[str, list[dict[str, Any]]] = {}
        self._counter = 0

    def next_id(self, kind: str) -> str:
        self._counter += 1
        return f"{kind}_new_{self._counter}"

    def seed(self, data: dict[str, Any]) -> None:
        self.workspaces = []
        self.workspace_boards = {}
        self.boards = {}
        self.board_lists = {}
        self.board_members = {}
        self.board_labels = {}
        self.labels_by_id = {}
        self.members_by_id = {}
        self.lists = {}
        self.list_cards = {}
        self.cards = {}
        self.card_comments = {}
        self._counter = 0
        for ws in data.get("workspaces", []):
            ws_id = ws["id"]
            self.workspaces.append({
                "id": ws_id,
                "displayName": ws.get("displayName"),
                "name": ws.get("name"),
            })
            self.workspace_boards[ws_id] = []
            for board in ws.get("boards", []):
                self._seed_board(ws_id, board)

    def _seed_board(self, ws_id: str, board: dict[str, Any]) -> None:
        board_id = board["id"]
        self.workspace_boards[ws_id].append(board_id)
        self.boards[board_id] = {
            "id": board_id,
            "name": board.get("name"),
            "idOrganization": ws_id,
            "closed": board.get("closed", False),
            "url": board.get("url"),
            "dateLastActivity": board.get("dateLastActivity"),
        }
        self.board_members[board_id] = list(board.get("members", []))
        for member in self.board_members[board_id]:
            self.members_by_id[member["id"]] = member
        self.board_labels[board_id] = []
        for label in board.get("labels", []):
            full = {
                "id": label["id"],
                "name": label.get("name"),
                "color": label.get("color"),
                "idBoard": board_id,
            }
            self.board_labels[board_id].append(full)
            self.labels_by_id[label["id"]] = full
        self.board_lists[board_id] = []
        for lst in board.get("lists", []):
            self._seed_list(board_id, lst)

    def _seed_list(self, board_id: str, lst: dict[str, Any]) -> None:
        list_id = lst["id"]
        self.board_lists[board_id].append(list_id)
        self.lists[list_id] = {
            "id": list_id,
            "name": lst.get("name"),
            "idBoard": board_id,
            "closed": lst.get("closed", False),
            "pos": lst.get("pos"),
        }
        self.list_cards[list_id] = []
        for card in lst.get("cards", []):
            self._seed_card(board_id, list_id, card)

    def _seed_card(self, board_id: str, list_id: str, card: dict[str,
                                                                 Any]) -> None:
        card_id = card["id"]
        self.list_cards[list_id].append(card_id)
        self.cards[card_id] = {
            "id": card_id,
            "name": card.get("name"),
            "desc": card.get("desc", ""),
            "idBoard": board_id,
            "idList": list_id,
            "idMembers": list(card.get("idMembers", [])),
            "labelIds": list(card.get("labelIds", [])),
            "due": card.get("due"),
            "dueComplete": card.get("dueComplete", False),
            "closed": card.get("closed", False),
            "dateLastActivity": card.get("dateLastActivity"),
            "shortUrl": f"https://trello.com/c/{card_id}",
        }
        self.card_comments[card_id] = []
        for comment in card.get("comments", []):
            self.card_comments[card_id].append({
                "id":
                comment["id"],
                "memberId":
                comment.get("memberId"),
                "text":
                comment.get("text", ""),
                "date":
                comment.get("date"),
            })

    def card_view(self, card_id: str) -> dict[str, Any]:
        card = self.cards[card_id]
        labels = [
            self.labels_by_id[lid] for lid in card["labelIds"]
            if lid in self.labels_by_id
        ]
        members = [
            self.members_by_id[mid] for mid in card["idMembers"]
            if mid in self.members_by_id
        ]
        return {
            "id": card["id"],
            "name": card["name"],
            "desc": card["desc"],
            "idBoard": card["idBoard"],
            "idList": card["idList"],
            "idMembers": card["idMembers"],
            "due": card["due"],
            "dueComplete": card["dueComplete"],
            "closed": card["closed"],
            "dateLastActivity": card["dateLastActivity"],
            "shortUrl": card["shortUrl"],
            "url": card["shortUrl"],
            "labels": labels,
            "members": members,
        }

    def comment_actions(self, card_id: str) -> list[dict[str, Any]]:
        rows = []
        for comment in self.card_comments.get(card_id, []):
            member = self.members_by_id.get(comment.get("memberId") or "", {})
            rows.append({
                "id": comment["id"],
                "type": "commentCard",
                "date": comment.get("date"),
                "memberCreator": {
                    "id": member.get("id"),
                    "fullName": member.get("fullName"),
                    "username": member.get("username"),
                },
                "data": {
                    "text": comment.get("text", ""),
                    "card": {
                        "id": card_id
                    },
                },
            })
        return rows


def _not_found(what: str) -> web.Response:
    return web.json_response({"message": f"{what} not found"}, status=404)


class TrelloServer:

    def __init__(self, state: FakeTrello) -> None:
        self.state = state

    async def reset(self, request: web.Request) -> web.Response:
        self.state.seed(json.loads(FIXTURE.read_text()))
        return web.json_response({"ok": True})

    async def organizations(self, request: web.Request) -> web.Response:
        return web.json_response(self.state.workspaces)

    async def org_boards(self, request: web.Request) -> web.Response:
        ws_id = request.match_info["ws_id"]
        board_ids = self.state.workspace_boards.get(ws_id)
        if board_ids is None:
            return _not_found("organization")
        return web.json_response([self.state.boards[bid] for bid in board_ids])

    async def board(self, request: web.Request) -> web.Response:
        board_id = request.match_info["board_id"]
        board = self.state.boards.get(board_id)
        if board is None:
            return _not_found("board")
        return web.json_response(board)

    async def board_lists(self, request: web.Request) -> web.Response:
        board_id = request.match_info["board_id"]
        list_ids = self.state.board_lists.get(board_id)
        if list_ids is None:
            return _not_found("board")
        return web.json_response([self.state.lists[lid] for lid in list_ids])

    async def board_members(self, request: web.Request) -> web.Response:
        board_id = request.match_info["board_id"]
        members = self.state.board_members.get(board_id)
        if members is None:
            return _not_found("board")
        return web.json_response(members)

    async def board_labels(self, request: web.Request) -> web.Response:
        board_id = request.match_info["board_id"]
        labels = self.state.board_labels.get(board_id)
        if labels is None:
            return _not_found("board")
        return web.json_response(labels)

    async def list_cards(self, request: web.Request) -> web.Response:
        list_id = request.match_info["list_id"]
        card_ids = self.state.list_cards.get(list_id)
        if card_ids is None:
            return _not_found("list")
        return web.json_response(
            [self.state.card_view(cid) for cid in card_ids])

    async def card(self, request: web.Request) -> web.Response:
        card_id = request.match_info["card_id"]
        if card_id not in self.state.cards:
            return _not_found("card")
        return web.json_response(self.state.card_view(card_id))

    async def card_actions(self, request: web.Request) -> web.Response:
        card_id = request.match_info["card_id"]
        if card_id not in self.state.cards:
            return _not_found("card")
        return web.json_response(self.state.comment_actions(card_id))

    async def create_card(self, request: web.Request) -> web.Response:
        params = request.query
        list_id = params.get("idList")
        if not list_id or list_id not in self.state.lists:
            return _not_found("list")
        card_id = self.state.next_id("crd")
        board_id = self.state.lists[list_id]["idBoard"]
        self.state.cards[card_id] = {
            "id": card_id,
            "name": params.get("name", ""),
            "desc": params.get("desc", ""),
            "idBoard": board_id,
            "idList": list_id,
            "idMembers": [],
            "labelIds": [],
            "due": None,
            "dueComplete": False,
            "closed": False,
            "dateLastActivity": WRITE_STAMP,
            "shortUrl": f"https://trello.com/c/{card_id}",
        }
        self.state.card_comments[card_id] = []
        self.state.list_cards[list_id].append(card_id)
        return web.json_response(self.state.card_view(card_id))

    async def update_card(self, request: web.Request) -> web.Response:
        card_id = request.match_info["card_id"]
        card = self.state.cards.get(card_id)
        if card is None:
            return _not_found("card")
        params = request.query
        if "name" in params:
            card["name"] = params["name"]
        if "desc" in params:
            card["desc"] = params["desc"]
        if "closed" in params:
            card["closed"] = params["closed"] == "true"
        if "due" in params:
            card["due"] = params["due"]
        if "dueComplete" in params:
            card["dueComplete"] = params["dueComplete"] == "true"
        if "idList" in params:
            new_list = params["idList"]
            if new_list not in self.state.lists:
                return _not_found("list")
            old_list = card["idList"]
            if card_id in self.state.list_cards.get(old_list, []):
                self.state.list_cards[old_list].remove(card_id)
            self.state.list_cards.setdefault(new_list, []).append(card_id)
            card["idList"] = new_list
            card["idBoard"] = self.state.lists[new_list]["idBoard"]
        card["dateLastActivity"] = WRITE_STAMP
        return web.json_response(self.state.card_view(card_id))

    async def add_member(self, request: web.Request) -> web.Response:
        card_id = request.match_info["card_id"]
        card = self.state.cards.get(card_id)
        if card is None:
            return _not_found("card")
        member_id = request.query.get("value")
        if member_id and member_id not in card["idMembers"]:
            card["idMembers"].append(member_id)
        return web.json_response(card["idMembers"])

    async def add_label(self, request: web.Request) -> web.Response:
        card_id = request.match_info["card_id"]
        card = self.state.cards.get(card_id)
        if card is None:
            return _not_found("card")
        label_id = request.query.get("value")
        if label_id and label_id not in card["labelIds"]:
            card["labelIds"].append(label_id)
        return web.json_response(card["labelIds"])

    async def remove_label(self, request: web.Request) -> web.Response:
        card_id = request.match_info["card_id"]
        label_id = request.match_info["label_id"]
        card = self.state.cards.get(card_id)
        if card is None:
            return _not_found("card")
        if label_id in card["labelIds"]:
            card["labelIds"].remove(label_id)
        return web.json_response(card["labelIds"])

    async def add_comment(self, request: web.Request) -> web.Response:
        card_id = request.match_info["card_id"]
        if card_id not in self.state.cards:
            return _not_found("card")
        comment_id = self.state.next_id("cmt")
        text = request.query.get("text", "")
        self.state.card_comments.setdefault(card_id, []).append({
            "id":
            comment_id,
            "memberId":
            None,
            "text":
            text,
            "date":
            WRITE_STAMP,
        })
        return web.json_response({
            "id": comment_id,
            "type": "commentCard",
            "date": WRITE_STAMP,
            "data": {
                "text": text,
                "card": {
                    "id": card_id
                }
            },
        })

    async def update_comment(self, request: web.Request) -> web.Response:
        card_id = request.match_info["card_id"]
        comment_id = request.match_info["comment_id"]
        for comment in self.state.card_comments.get(card_id, []):
            if comment["id"] == comment_id:
                comment["text"] = request.query.get("text", "")
                return web.json_response({
                    "id": comment_id,
                    "type": "commentCard",
                    "data": {
                        "text": comment["text"],
                        "card": {
                            "id": card_id
                        }
                    },
                })
        return _not_found("comment")


def build_app(server: TrelloServer) -> web.Application:
    app = web.Application()
    app.router.add_post("/reset", server.reset)
    app.router.add_get("/members/me/organizations", server.organizations)
    app.router.add_get("/organizations/{ws_id}/boards", server.org_boards)
    app.router.add_get("/boards/{board_id}", server.board)
    app.router.add_get("/boards/{board_id}/lists", server.board_lists)
    app.router.add_get("/boards/{board_id}/members", server.board_members)
    app.router.add_get("/boards/{board_id}/labels", server.board_labels)
    app.router.add_get("/lists/{list_id}/cards", server.list_cards)
    app.router.add_get("/cards/{card_id}", server.card)
    app.router.add_get("/cards/{card_id}/actions", server.card_actions)
    app.router.add_post("/cards", server.create_card)
    app.router.add_put("/cards/{card_id}", server.update_card)
    app.router.add_post("/cards/{card_id}/idMembers", server.add_member)
    app.router.add_post("/cards/{card_id}/idLabels", server.add_label)
    app.router.add_delete("/cards/{card_id}/idLabels/{label_id}",
                          server.remove_label)
    app.router.add_post("/cards/{card_id}/actions/comments",
                        server.add_comment)
    app.router.add_put("/cards/{card_id}/actions/{comment_id}/comments",
                       server.update_comment)
    return app


async def start_fake_trello(
) -> tuple[FakeTrello, TrelloServer, web.AppRunner]:
    state = FakeTrello()
    state.seed(json.loads(FIXTURE.read_text()))
    server = TrelloServer(state)
    runner = web.AppRunner(build_app(server))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    state.base = f"http://127.0.0.1:{port}"
    return state, server, runner


async def _serve(port: int) -> None:
    state = FakeTrello()
    state.seed(json.loads(FIXTURE.read_text()))
    server = TrelloServer(state)
    runner = web.AppRunner(build_app(server))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    state.base = f"http://127.0.0.1:{port}"
    print(f"TRELLO_ENDPOINT={state.base}", flush=True)
    await asyncio.Event().wait()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    asyncio.run(_serve(args.port))


if __name__ == "__main__":
    main()
