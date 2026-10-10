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

from dataclasses import FrozenInstanceError

import pytest

from mirage.commands.config import Command, CommandCatalog, command
from mirage.commands.spec import CommandSpec


async def _handler(accessor, paths, texts, opts):
    return None, None


def _decorated(name: str, filetype: str | None = None):
    return command(name, vfs="s3", spec=CommandSpec(), filetype=filetype)(
        _handler
    )


def test_catalog_iterates_definitions_and_resolves_decorated_commands():
    source = [_decorated("cat"), _decorated("cat", ".demo")]
    catalog = CommandCatalog(source)

    assert list(catalog) == [fn._registered_commands[0] for fn in source]
    assert catalog.require("cat").filetype is None
    assert catalog.require("cat", ".demo").filetype == ".demo"


def test_catalog_accepts_registered_command_values():
    registered = Command(
        name="cat", spec=CommandSpec(), vfs="s3", filetype=None, fn=_handler
    )
    catalog = CommandCatalog([registered])

    assert catalog.require("cat") is registered


def test_catalog_get_and_require_have_explicit_missing_behavior():
    catalog = CommandCatalog([_decorated("cat")])

    assert catalog.get("missing") is None
    with pytest.raises(KeyError, match="missing"):
        catalog.require("missing")


def test_catalog_is_a_snapshot_of_its_source():
    source = [_decorated("cat")]
    catalog = CommandCatalog(source)

    source.append(_decorated("tail"))

    assert len(catalog) == 1
    assert catalog.get("tail") is None


def test_registered_command_is_immutable():
    registered = Command(
        name="cat", spec=CommandSpec(), vfs="s3", filetype=None, fn=_handler
    )

    with pytest.raises(FrozenInstanceError):
        registered.name = "tail"


def test_with_overrides_returns_an_independent_definition():
    original = Command(
        name="cat", spec=CommandSpec(), vfs="s3", filetype=None, fn=_handler
    )

    async def replacement(accessor, paths, texts, opts):
        return None, None

    changed = original.with_overrides(fn=replacement)

    assert changed is not original
    assert changed.fn is replacement
    assert original.fn is _handler


def test_s3_commands_expose_static_lookup():
    from mirage.commands.builtin.s3 import COMMANDS

    rm = COMMANDS.require("rm")

    assert rm.name == "rm"
    assert rm.vfs == "s3"
    assert rm.filetype is None
