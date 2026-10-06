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

import pytest

from mirage.accessor.trello import TrelloAccessor
from mirage.commands.builtin.trello.trello_card_assign import (
    trello_card_assign,
)
from mirage.commands.builtin.trello.trello_card_comment_add import (
    trello_card_comment_add,
)
from mirage.commands.builtin.trello.trello_card_comment_update import (
    trello_card_comment_update,
)
from mirage.commands.builtin.trello.trello_card_create import (
    trello_card_create,
)
from mirage.commands.builtin.trello.trello_card_label_add import (
    trello_card_label_add,
)
from mirage.commands.builtin.trello.trello_card_label_remove import (
    trello_card_label_remove,
)
from mirage.commands.builtin.trello.trello_card_move import trello_card_move
from mirage.commands.builtin.trello.trello_card_update import (
    trello_card_update,
)
from mirage.commands.config import CommandFn, CommandOpts
from mirage.context import reset_mount_gate, set_mount_gate
from mirage.errors.types import ReadOnlyError
from mirage.types import MountMode
from mirage.vfs.trello.config import TrelloConfig

_ACCESSOR = TrelloAccessor(TrelloConfig(api_key="k", api_token="t"))

# Every card write, with the flags that pass its own validation, so the
# refusal below is the guard's and not a missing-flag ValueError. The
# guard fires before the client, so no case reaches the network.
CASES = [
    pytest.param(
        trello_card_create,
        {"list_id": "l1", "name": "card"},
        id="trello card create",
    ),
    pytest.param(
        trello_card_comment_add,
        {"card_id": "c1", "text": "hi"},
        id="trello card comment",
    ),
    pytest.param(
        trello_card_comment_update,
        {"card_id": "c1", "comment_id": "m1", "text": "hi"},
        id="trello card comment-update",
    ),
    pytest.param(
        trello_card_assign,
        {"card_id": "c1", "member_id": "u1"},
        id="trello card assign",
    ),
    pytest.param(
        trello_card_label_add,
        {"card_id": "c1", "label_id": "g1"},
        id="trello card label",
    ),
    pytest.param(
        trello_card_label_remove,
        {"card_id": "c1", "label_id": "g1"},
        id="trello card unlabel",
    ),
    pytest.param(
        trello_card_move,
        {"card_id": "c1", "list_id": "l2"},
        id="trello card move",
    ),
    pytest.param(
        trello_card_update,
        {"card_id": "c1", "name": "renamed"},
        id="trello card update",
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("cmd,flags", CASES)
async def test_a_read_mount_refuses_an_id_addressed_write(
    cmd: CommandFn, flags: dict[str, str]
) -> None:
    """Every card write declares ``write=True`` and refuses under a READ
    mount gate.

    ``Mount.execute_cmd``'s write-command gate keys on the registration
    flag. An id-addressed write names no path the per-path mode guard
    could judge, so each handler must also call ``require_mount_writable``
    itself (after its own validation, before the client call). With no
    session bound the configured mode stands, so a READ gate alone must
    refuse.
    """
    assert getattr(cmd, "_registered_commands")[0].write is True
    token = set_mount_gate("/trello", MountMode.READ)
    try:
        with pytest.raises(ReadOnlyError):
            await cmd(_ACCESSOR, [], [], CommandOpts(flags=flags))
    finally:
        reset_mount_gate(token)


_SCOPED = TrelloAccessor(
    TrelloConfig(
        api_key="k",
        api_token="t",
        board_ids=["b_in"],
        base_url="http://127.0.0.1:9",
    )
)


async def _on_board_out(config, ident, session=None):
    return {"id": ident, "idBoard": "b_out"}


@pytest.mark.asyncio
@pytest.mark.parametrize("cmd,flags", CASES)
async def test_a_card_write_refuses_an_id_outside_the_scope(
    cmd: CommandFn, flags: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every card write refuses a card or list on a board the mount's
    ``board_ids`` / ``workspace_id`` leave out, before the write.

    The write is addressed by id, so without the check a mount narrowed
    to one board writes to any board the token can reach. The base_url
    is unroutable: a write that got past the check would fail with a
    connection error, not the refusal.
    """
    monkeypatch.setattr(
        "mirage.commands.builtin.trello._scope.get_card", _on_board_out
    )
    monkeypatch.setattr(
        "mirage.commands.builtin.trello._scope.get_list", _on_board_out
    )
    token = set_mount_gate("/trello", MountMode.WRITE)
    try:
        with pytest.raises(
            ValueError, match=" is outside this mount's scope$"
        ):
            await cmd(_SCOPED, [], [], CommandOpts(flags=flags))
    finally:
        reset_mount_gate(token)
