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

from mirage import Workspace
from mirage.commands.cli.builtin.ntn import NTN
from mirage.commands.cli.builtin.ntn.pages import create as pages_create
from mirage.core.notion.config import NotionConfig
from mirage.io.types import materialize

CONFIG = {"api_key": "secret"}

# Verbs the official CLI ships that a virtualized CLI deliberately does
# not: two are interactive browser flows, two manage the binary or a
# deploy target, and one uploads local files a session does not have.
OUT_OF_SCOPE = ("login", "logout", "update", "workers", "notion-as-code",
                "doctor", "files")


def leaf(*path: str):
    node = NTN
    for name in path:
        node = next(c for c in node.subcommands if c.name == name)
    return node


def verb(*path: str):
    """The handler a leaf wraps, for patching the module it lives in.

    Every ntn leaf is registered as ``partial(guarded, verb)`` so an API
    failure answers in upstream's voice, which puts the partial where the
    function used to be. Reach through it the same way a ``@command``
    wrapper is reached through ``__wrapped__``.

    Args:
        path (str): the subcommand words under the root.
    """
    return leaf(*path).fn.args[0]


def test_tree_shape_matches_the_official_grammar():
    assert NTN.name == "ntn"
    assert NTN.config_model is NotionConfig
    assert [g.name for g in NTN.subcommands
            ] == ["api", "auth", "datasources", "pages", "whoami"]
    assert [v.name for v in leaf("pages").subcommands
            ] == ["get", "create", "edit", "trash"]
    assert [v.name
            for v in leaf("datasources").subcommands] == ["query", "resolve"]
    assert [v.name for v in leaf("auth").subcommands] == ["token"]


def test_no_invented_groups():
    # blocks, comments and search were mirage inventions; the official
    # CLI reaches those endpoints through `ntn api`, and so does mirage.
    names = {g.name for g in NTN.subcommands}
    assert names.isdisjoint({"blocks", "comments", "search"})
    assert names.isdisjoint(OUT_OF_SCOPE)


def test_ids_are_positional():
    # Names are upstream's, verbatim, because they are what a missing
    # operand is refused by name with (integ/ntn_conformance.ts pins the
    # refusal against the real binary).
    named = {
        ("pages", "get"): "PAGE_ID",
        ("pages", "edit"): "PAGE_ID",
        ("pages", "trash"): "PAGE_ID",
        ("datasources", "query"): "ID_OR_URL",
        ("datasources", "resolve"): "ID",
    }
    for path, slot in named.items():
        node = leaf(*path)
        assert node.rest is None, path
        assert len(node.positional) == 1, path
        assert node.positional[0].name == slot, path
        assert node.positional[0].required, path
        spellings = {opt.long for opt in node.options}
        assert "--page" not in spellings
        assert "--datasource" not in spellings


def test_api_path_is_optional():
    # `ntn api` with no operand prints its help rather than refusing, so
    # its slot is the one that must not be required.
    node = leaf("api")
    assert node.rest is not None
    assert node.rest.name == "PATH"
    assert not node.rest.required


def test_notion_version_is_env_backed():
    # Declared once on the shared option, so every verb that carries it
    # honors NOTION_API_VERSION identically.
    for path in (("pages", "get"), ("datasources", "query"), ("whoami", )):
        option = next(opt for opt in leaf(*path).options
                      if opt.long == "--notion-version")
        assert option.env == "NOTION_API_VERSION", path
        assert option.metavar == "VERSION", path


def test_write_classification():
    assert not leaf("pages", "get").write
    for verb in ("create", "edit", "trash"):
        assert leaf("pages", verb).write
    assert not leaf("datasources", "query").write
    assert not leaf("datasources", "resolve").write
    assert not leaf("whoami").write
    assert not leaf("auth", "token").write


@pytest.mark.asyncio
async def test_installed_tree_dispatches_pages_create(monkeypatch):

    async def fake_create(config, body):
        return {"id": "P1", "object": "page", "parent": body["parent"]}

    monkeypatch.setitem(pages_create.create.__globals__, "create_page",
                        fake_create)
    ws = Workspace({})
    ws.register_cli("ntn", NTN, CONFIG)
    io = await ws.execute(
        "ntn pages create --content '# Hi' --parent page:root")
    assert io.exit_code == 0
    assert (await materialize(io.stdout)) == b"P1\n"
    await ws.close()


@pytest.mark.asyncio
async def test_page_id_is_taken_from_the_operand(monkeypatch):
    seen = []

    async def fake_update(config, page_id, body):
        seen.append((page_id, body))
        return {"id": page_id}

    monkeypatch.setitem(
        verb("pages", "trash").__globals__, "update_page", fake_update)
    ws = Workspace({})
    ws.register_cli("ntn", NTN, CONFIG)
    io = await ws.execute("ntn pages trash P9 --yes")
    assert io.exit_code == 0
    assert seen == [("P9", {"in_trash": True})]
    await ws.close()


@pytest.mark.asyncio
async def test_malformed_filter_is_a_usage_error():
    ws = Workspace({})
    ws.register_cli("ntn", NTN, CONFIG)
    io = await ws.execute("ntn datasources query S1 --filter '{not json'")
    assert io.exit_code == 2
    assert (await materialize(io.stderr)) == b"--filter must be valid JSON\n"
    await ws.close()
