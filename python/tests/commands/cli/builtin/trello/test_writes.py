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

import json

import pytest

from mirage.accessor.trello import TrelloAccessor
from mirage.commands.cli.builtin.trello import TRELLO
from mirage.commands.cli.builtin.trello.card.update import update
from mirage.commands.config import Context
from mirage.commands.spec.types import CommandSpec
from mirage.core.trello.config import TrelloConfig
from mirage.io.types import materialize
from mirage.types import PathSpec
from mirage.workspace.files import Files

# Every card write, with the flags that pass its own validation, so the
# refusal below is the scope's and not a missing-flag ValueError.
CASES = [
    pytest.param(
        "card create", {"list_id": "l1", "name": "card"}, id="create"
    ),
    pytest.param(
        "card comment", {"card_id": "c1", "text": "hi"}, id="comment"
    ),
    pytest.param(
        "card comment-update",
        {"card_id": "c1", "comment_id": "m1", "text": "hi"},
        id="comment-update",
    ),
    pytest.param(
        "card assign", {"card_id": "c1", "member_id": "u1"}, id="assign"
    ),
    pytest.param(
        "card label", {"card_id": "c1", "label_id": "g1"}, id="label"
    ),
    pytest.param(
        "card unlabel", {"card_id": "c1", "label_id": "g1"}, id="unlabel"
    ),
    pytest.param("card move", {"card_id": "c1", "list_id": "l2"}, id="move"),
    pytest.param(
        "card update", {"card_id": "c1", "name": "renamed"}, id="update"
    ),
]


def _spec(path: str) -> CommandSpec:
    node = TRELLO.spec
    for name in path.split():
        node = next(c for c in node.subcommands if c.name == name)
    return node


@pytest.mark.parametrize("path,flags", CASES)
def test_every_card_write_is_classified_as_a_write(
    path: str, flags: dict[str, str]
) -> None:
    """The handler's ``write`` is what policy calls a write and what
    drops the mounts' caches after the leaf runs; an account CLI's write
    consults no mount mode."""
    assert TRELLO.handlers[path].write is True


_SCOPED = TrelloAccessor(
    TrelloConfig(
        api_key="k",
        api_token="t",
        board_ids=["b_in"],
        base_url="http://127.0.0.1:9",
    )
)


async def _on_board_out(accessor, ident):
    return {"id": ident, "idBoard": "b_out"}


@pytest.mark.asyncio
@pytest.mark.parametrize("path,flags", CASES)
async def test_a_card_write_refuses_an_id_outside_the_scope(
    path: str, flags: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every card write refuses a card or list on a board the config's
    ``board_ids`` / ``workspace_id`` leave out, before the write.

    The write is addressed by id, so without the check an install
    narrowed to one board writes to any board the token can reach. The
    base_url is unroutable: a write that got past the check would fail
    with a connection error, not the refusal.
    """
    monkeypatch.setattr(
        "mirage.commands.cli.builtin.trello.scope.get_card", _on_board_out
    )
    monkeypatch.setattr(
        "mirage.commands.cli.builtin.trello.scope.get_list", _on_board_out
    )
    fn = TRELLO.handlers[path].fn
    assert fn is not None
    with pytest.raises(ValueError, match=" is outside the configured scope$"):
        await fn(_SCOPED, [], [], Context(flags=flags, spec=_spec(path)))


@pytest.mark.asyncio
async def test_a_desc_file_is_read_through_the_session_files(monkeypatch):
    read: list[PathSpec] = []
    sent: dict[str, str | None] = {}

    async def dispatch(op, path, *args, **kwargs):
        assert op == "read"
        read.append(path)
        return b"from a file", None

    async def fake_card_update(accessor, *, card_id, name, desc, closed, due):
        sent["desc"] = desc
        return {"id": card_id, "desc": desc}

    monkeypatch.setitem(update.__globals__, "card_update", fake_card_update)
    operand = PathSpec.from_str_path("/scratch/desc.txt")
    out, _io = await update(
        TrelloAccessor(TrelloConfig(api_key="k", api_token="t")),
        [],
        [],
        Context(
            flags={"card_id": "c1", "desc_file": operand},
            spec=_spec("card update"),
            vfs=Files([], dispatch),
        ),
    )
    assert json.loads(await materialize(out))["desc"] == "from a file"
    assert sent["desc"] == "from a file"
    assert [p.virtual for p in read] == ["/scratch/desc.txt"]


@pytest.mark.asyncio
async def test_a_desc_file_outside_a_workspace_is_refused():
    operand = PathSpec.from_str_path("/scratch/desc.txt")
    with pytest.raises(
        ValueError, match="^--desc_file needs a workspace to read files from$"
    ):
        await update(
            TrelloAccessor(TrelloConfig(api_key="k", api_token="t")),
            [],
            [],
            Context(
                flags={"card_id": "c1", "desc_file": operand},
                spec=_spec("card update"),
            ),
        )
