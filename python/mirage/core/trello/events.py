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

import logging
from collections.abc import Sequence

from mirage.accessor.trello import TrelloAccessor
from mirage.core.trello.client import (
    TrelloAPIError,
    get_board,
    get_card,
    get_list,
    list_workspaces,
)
from mirage.core.trello.pathing import (
    board_dirname,
    card_dirname,
    list_dirname,
    workspace_dirname,
)
from mirage.events.delta import moved_below
from mirage.events.payload import event_at, field, text_field
from mirage.types import FileChangeKind, FileEvent, JsonValue, PathSpec

logger = logging.getLogger(__name__)

_CARD_FILES = ("card.json", "comments.jsonl")

_CARD_MADE = frozenset(
    {
        "createCard",
        "copyCard",
        "convertToCardFromCheckItem",
        "moveCardToBoard",
    }
)
_CARD_GONE = frozenset({"deleteCard", "moveCardFromBoard"})
_CARD_EDITS = frozenset(
    {
        "addLabelToCard",
        "removeLabelFromCard",
        "addMemberToCard",
        "removeMemberFromCard",
    }
)
_COMMENT_EDITS = frozenset({"commentCard", "updateComment", "deleteComment"})
_LABEL_EDITS = frozenset({"createLabel", "updateLabel", "deleteLabel"})
_MEMBER_EDITS = frozenset({"addMemberToBoard", "removeMemberFromBoard"})


def _named(entity: JsonValue, name: str | None = None) -> dict[str, str]:
    """An entity's id and name as the dirname helpers read them.

    Args:
        entity (JsonValue): A card, list or board as an action names it.
        name (str | None): A name to use instead of the entity's own.
    """
    return {
        "id": text_field(entity, "id") or "",
        "name": name or text_field(entity, "name") or "",
    }


class TrelloEventHook:
    """Map one Trello webhook delivery onto mount paths.

    The consumer owns the callback URL and passes the action's ``type``
    with the whole delivery body (``action`` and ``model``). Nothing
    here runs a loop.

    Every directory is ``<name>__<id>``, and an action names the board,
    list and card it touched with both, so a path is built from the
    action alone; only the workspace a board sits in is read, once per
    board, from the delivery's board ``model`` or ``/boards/<id>``. A
    board outside the mount's ``workspace_id`` or ``board_ids`` maps to
    nothing.

    A card is the directory ``.../lists/<list>/cards/<card>`` with
    ``card.json`` and ``comments.jsonl``. A card made or moved in
    creates both, and one deleted, archived or moved to another board
    deletes its directory; a deleted card names no name, so where the
    hook saw it last is used, and a card it never saw makes its list's
    ``cards`` UNKNOWN. An action on a card that does not name its list
    (a label or a member added) reads the card and its list once, and
    one Trello no longer has makes the board UNKNOWN. A card
    renamed or moved to another list moves both files. A comment updates
    ``comments.jsonl``, and a change to what ``card.json`` renders (its
    fields, labels or members) updates that.

    A list or a board renamed moves everything below it, which no action
    lists, so the old and new directory are UNKNOWN, and the cards the
    hook remembers below it move with it; one archived is deleted, and
    one restored is UNKNOWN. A board moved out of the mount's workspace
    is deleted where it was. Any other change to a list or a board
    updates its ``list.json`` or ``board.json``. A label or a board
    member added, changed or removed is UNKNOWN on ``labels`` or
    ``members``, since the file names come from what changed.
    """

    def __init__(self, accessor: TrelloAccessor) -> None:
        """Args:
        accessor (TrelloAccessor): Backend handle, read for its config
            and used to resolve workspaces.
        """
        self._accessor = accessor
        self._workspaces: dict[str, str] = {}
        self._orgs: dict[str, str | None] = {}
        self._cards: dict[str, str] = {}

    async def _workspace_dir(self, workspace_id: str) -> str | None:
        """The directory of a workspace, from one listing, remembered.

        Args:
            workspace_id (str): The workspace's id.
        """
        if workspace_id not in self._workspaces:
            for listed in await list_workspaces(
                self._accessor.config, session=self._accessor.pool
            ):
                self._workspaces[str(listed.get("id"))] = workspace_dirname(
                    listed
                )
        return self._workspaces.get(workspace_id)

    async def _org(self, board_id: str, model: JsonValue) -> str | None:
        """The workspace a board sits in, remembered.

        Args:
            board_id (str): The board's id.
            model (JsonValue): The delivery's ``model``.
        """
        if text_field(model, "id") == board_id and isinstance(model, dict):
            self._orgs[board_id] = text_field(model, "idOrganization")
        if board_id not in self._orgs:
            board = await get_board(
                self._accessor.config, board_id, session=self._accessor.pool
            )
            self._orgs[board_id] = text_field(board, "idOrganization")
        return self._orgs[board_id]

    async def _board_dir(
        self,
        board: JsonValue,
        model: JsonValue,
        name: str | None = None,
        org: str | None = None,
    ) -> str | None:
        """The directory of a board the mount shows, or None.

        Args:
            board (JsonValue): The board as the action names it.
            model (JsonValue): The delivery's ``model``.
            name (str | None): A name to use instead of the board's own.
            org (str | None): A workspace to use instead of the board's.
        """
        board_id = text_field(board, "id")
        if board_id is None:
            return None
        config = self._accessor.config
        if config.board_ids and board_id not in config.board_ids:
            return None
        workspace_id = org or await self._org(board_id, model)
        if workspace_id is None or (
            config.workspace_id and workspace_id != config.workspace_id
        ):
            return None
        workspace = await self._workspace_dir(workspace_id)
        if workspace is None:
            return None
        named = board_dirname(_named(board, name))
        return f"workspaces/{workspace}/boards/{named}"

    def _card_dir(
        self,
        board_dir: str,
        card: JsonValue,
        lst: JsonValue,
        name: str | None = None,
    ) -> str | None:
        """Where a card is, from the action's names or where it was seen.

        Args:
            board_dir (str): The card's board directory.
            card (JsonValue): The card as the action names it.
            lst (JsonValue): The list the action puts it in.
            name (str | None): A name to use instead of the card's own.
        """
        card_id = text_field(card, "id")
        if card_id is None:
            return None
        if text_field(lst, "id") is None or not (
            name or text_field(card, "name")
        ):
            return self._cards.get(card_id)
        place = (
            f"{board_dir}/lists/{list_dirname(_named(lst))}/cards/"
            + card_dirname(_named(card, name))
        )
        self._cards[card_id] = place
        return place

    async def _located(self, board_dir: str, card_id: str) -> str | None:
        """Where a card an action names without its list is, read from
        the card and its list, or None when Trello no longer has either,
        as for a delivery that arrives after the card was deleted.

        Args:
            board_dir (str): The card's board directory.
            card_id (str): The card's id.
        """
        config = self._accessor.config
        try:
            found = await get_card(
                config, card_id, session=self._accessor.pool
            )
            list_id = text_field(found, "idList")
            if list_id is None:
                return None
            lst = await get_list(config, list_id, session=self._accessor.pool)
        except TrelloAPIError as exc:
            if exc.status != 404:
                raise
            logger.debug("trello events: card %s is gone: %s", card_id, exc)
            return None
        return self._card_dir(board_dir, found, lst)

    def _files(
        self, root: PathSpec, place: str, kind: FileChangeKind
    ) -> list[FileEvent]:
        """One event on each of a card's files.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            place (str): The card's directory.
            kind (FileChangeKind): What happened to them.
        """
        return [
            event_at(root, f"{place}/{name}", kind) for name in _CARD_FILES
        ]

    async def _update_card(
        self, root: PathSpec, board_dir: str, data: JsonValue
    ) -> Sequence[FileEvent]:
        """Map an ``updateCard``: a rename, a move between lists, an
        archive or restore, or a field change.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            board_dir (str): The card's board directory.
            data (JsonValue): The action's ``data``.
        """
        card = field(data, "card")
        old = field(data, "old")
        lst = field(data, "list")
        before = field(data, "listBefore")
        after = field(data, "listAfter")
        was = self._card_dir(
            board_dir,
            card,
            lst if before is None else before,
            text_field(old, "name"),
        )
        now = self._card_dir(board_dir, card, lst if after is None else after)
        card_id = text_field(card, "id")
        if now is None and card_id is not None:
            now = await self._located(board_dir, card_id)
            if now is None:
                return (event_at(root, board_dir, FileChangeKind.UNKNOWN),)
        if now is None:
            return ()
        if field(old, "closed") is not None:
            if field(card, "closed") is True:
                self._cards.pop(text_field(card, "id") or "", None)
                return (event_at(root, now, FileChangeKind.DELETE),)
            return tuple(self._files(root, now, FileChangeKind.CREATE))
        if was is not None and was != now:
            return tuple(
                event_at(
                    root,
                    f"{now}/{name}",
                    FileChangeKind.MOVE,
                    previous=f"{was}/{name}",
                )
                for name in _CARD_FILES
            )
        return (event_at(root, f"{now}/card.json", FileChangeKind.UPDATE),)

    async def _card(
        self, root: PathSpec, kind: str, board_dir: str, data: JsonValue
    ) -> Sequence[FileEvent]:
        """Map an action on one card.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            kind (str): The action's ``type``.
            board_dir (str): The card's board directory.
            data (JsonValue): The action's ``data``.
        """
        if kind == "updateCard":
            return await self._update_card(root, board_dir, data)
        card = field(data, "card")
        lst = field(data, "list")
        place = self._card_dir(board_dir, card, lst)
        if kind in _CARD_GONE:
            self._cards.pop(text_field(card, "id") or "", None)
            if place is not None:
                return (event_at(root, place, FileChangeKind.DELETE),)
            if text_field(lst, "id") is None:
                return ()
            cards = f"{board_dir}/lists/{list_dirname(_named(lst))}/cards"
            return (event_at(root, cards, FileChangeKind.UNKNOWN),)
        card_id = text_field(card, "id")
        if place is None and card_id is not None:
            place = await self._located(board_dir, card_id)
            if place is None:
                return (event_at(root, board_dir, FileChangeKind.UNKNOWN),)
        if place is None:
            return ()
        if kind in _CARD_MADE:
            return tuple(self._files(root, place, FileChangeKind.CREATE))
        name = "comments.jsonl" if kind in _COMMENT_EDITS else "card.json"
        return (event_at(root, f"{place}/{name}", FileChangeKind.UPDATE),)

    def _list(
        self, root: PathSpec, kind: str, board_dir: str, data: JsonValue
    ) -> Sequence[FileEvent]:
        """Map an action on one list.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            kind (str): The action's ``type``.
            board_dir (str): The list's board directory.
            data (JsonValue): The action's ``data``.
        """
        lst = field(data, "list")
        if text_field(lst, "id") is None:
            return ()
        lists = f"{board_dir}/lists"
        now = f"{lists}/{list_dirname(_named(lst))}"
        old = field(data, "old")
        if kind == "createList":
            return (event_at(root, f"{now}/list.json", FileChangeKind.CREATE),)
        if kind == "moveListFromBoard" or (
            field(old, "closed") is not None and field(lst, "closed") is True
        ):
            moved_below(self._cards, {now: None}, set())
            return (event_at(root, now, FileChangeKind.DELETE),)
        old_name = text_field(old, "name")
        if old_name is not None:
            was = f"{lists}/{list_dirname(_named(lst, old_name))}"
            moved_below(self._cards, {was: now}, set())
            return (
                event_at(root, was, FileChangeKind.UNKNOWN),
                event_at(root, now, FileChangeKind.UNKNOWN),
            )
        if kind == "moveListToBoard" or field(old, "closed") is not None:
            return (event_at(root, now, FileChangeKind.UNKNOWN),)
        return (event_at(root, f"{now}/list.json", FileChangeKind.UPDATE),)

    async def _board(
        self,
        root: PathSpec,
        board_dir: str,
        data: JsonValue,
        model: JsonValue,
    ) -> Sequence[FileEvent]:
        """Map an ``updateBoard``.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            board_dir (str): The board's directory.
            data (JsonValue): The action's ``data``.
            model (JsonValue): The delivery's ``model``.
        """
        board = field(data, "board")
        old = field(data, "old")
        if field(old, "closed") is not None:
            if field(board, "closed") is not True:
                return (event_at(root, board_dir, FileChangeKind.UNKNOWN),)
            moved_below(self._cards, {board_dir: None}, set())
            return (event_at(root, board_dir, FileChangeKind.DELETE),)
        old_name = text_field(old, "name")
        old_org = text_field(old, "idOrganization")
        if old_name is None and old_org is None:
            return (
                event_at(
                    root, f"{board_dir}/board.json", FileChangeKind.UPDATE
                ),
            )
        events = [event_at(root, board_dir, FileChangeKind.UNKNOWN)]
        was = await self._board_dir(board, model, old_name, old_org)
        if was is not None and was != board_dir:
            moved_below(self._cards, {was: board_dir}, set())
            events.insert(0, event_at(root, was, FileChangeKind.UNKNOWN))
        return tuple(events)

    async def _left(
        self, root: PathSpec, data: JsonValue, model: JsonValue
    ) -> Sequence[FileEvent]:
        """Map an ``updateBoard`` that moved a board out of the workspace
        the mount shows: it is deleted where it was.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            data (JsonValue): The action's ``data``.
            model (JsonValue): The delivery's ``model``.
        """
        old = field(data, "old")
        old_org = text_field(old, "idOrganization")
        if old_org is None:
            return ()
        was = await self._board_dir(
            field(data, "board"), model, text_field(old, "name"), old_org
        )
        if was is None:
            return ()
        moved_below(self._cards, {was: None}, set())
        return (event_at(root, was, FileChangeKind.DELETE),)

    async def to_events(
        self, root: PathSpec, event_type: str, payload: JsonValue
    ) -> Sequence[FileEvent]:
        """Map one webhook delivery to the changes it implies.

        Args:
            root (PathSpec): Any path on this mount, read for its prefix.
            event_type (str): The action's ``type``.
            payload (JsonValue): The delivery body, ``action`` and
                ``model``.
        """
        data = field(field(payload, "action"), "data")
        model = field(payload, "model")
        board_dir = await self._board_dir(field(data, "board"), model)
        if board_dir is None:
            if event_type == "updateBoard":
                return await self._left(root, data, model)
            return ()
        if (
            event_type in _CARD_MADE
            or event_type in _CARD_GONE
            or event_type in _CARD_EDITS
            or event_type in _COMMENT_EDITS
            or event_type == "updateCard"
        ):
            return await self._card(root, event_type, board_dir, data)
        if event_type in (
            "createList",
            "updateList",
            "moveListFromBoard",
            "moveListToBoard",
        ):
            return self._list(root, event_type, board_dir, data)
        if event_type == "updateBoard":
            return await self._board(root, board_dir, data, model)
        if event_type in _LABEL_EDITS:
            return (
                event_at(root, f"{board_dir}/labels", FileChangeKind.UNKNOWN),
            )
        if event_type in _MEMBER_EDITS:
            return (
                event_at(root, f"{board_dir}/members", FileChangeKind.UNKNOWN),
            )
        return ()
