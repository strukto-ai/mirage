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

from mirage.commands.config import RegisteredCommand, command
from mirage.commands.spec import CommandSpec


async def _handler(accessor, paths, texts, opts):
    return None, None


async def _replacement_handler(accessor, paths, texts, opts):
    return None, None


async def _provision(*args, **kwargs):
    return None


def _catalog_type():
    from mirage.commands import registry

    assert hasattr(registry, "CommandCatalog")
    return registry.CommandCatalog


def _decorated(name: str, filetype: str | None = None):
    return command(name, vfs="s3", spec=CommandSpec(),
                   filetype=filetype)(_handler)


def test_catalog_iterates_definitions_and_resolves_decorated_commands():
    source = [_decorated("cat"), _decorated("cat", ".demo")]
    catalog = _catalog_type()(source)

    assert list(catalog) == [fn._registered_commands[0] for fn in source]
    assert catalog.require("cat").filetype is None
    assert catalog.require("cat", ".demo").filetype == ".demo"


def test_catalog_accepts_registered_command_values():
    registered = RegisteredCommand(name="cat",
                                   spec=CommandSpec(),
                                   vfs="s3",
                                   filetype=None,
                                   fn=_handler)
    catalog = _catalog_type()([registered])

    assert catalog.require("cat") is registered


def test_catalog_get_and_require_have_explicit_missing_behavior():
    catalog = _catalog_type()([_decorated("cat")])

    assert catalog.get("missing") is None
    with pytest.raises(KeyError, match="missing"):
        catalog.require("missing")


def test_catalog_is_an_immutable_snapshot():
    source = [_decorated("cat")]
    catalog = _catalog_type()(source)

    source.append(_decorated("tail"))

    assert len(catalog) == 1
    with pytest.raises(FrozenInstanceError):
        catalog._items = ()


def test_with_overrides_returns_an_independent_definition():
    original = RegisteredCommand(name="cat",
                                 spec=CommandSpec(),
                                 vfs="s3",
                                 filetype=None,
                                 fn=_handler)

    changed = original.with_overrides(fn=_replacement_handler,
                                      provision=_provision)

    assert changed is not original
    assert changed.fn is _replacement_handler
    assert changed.provision_fn is _provision
    assert original.fn is _handler
    assert original.provision_fn is None


def test_with_overrides_can_clear_a_provision():
    original = RegisteredCommand(name="cat",
                                 spec=CommandSpec(),
                                 vfs="s3",
                                 filetype=None,
                                 fn=_handler,
                                 provision_fn=_provision)

    changed = original.with_overrides(provision=None)

    assert changed.provision_fn is None
    assert original.provision_fn is _provision


def test_registered_command_is_immutable():
    registered = RegisteredCommand(name="cat",
                                   spec=CommandSpec(),
                                   vfs="s3",
                                   filetype=None,
                                   fn=_handler)

    with pytest.raises(FrozenInstanceError):
        registered.name = "tail"


def test_s3_commands_expose_static_lookup():
    from mirage.commands.builtin.s3 import COMMANDS

    cat = COMMANDS.require("cat")

    assert cat.name == "cat"
    assert cat.vfs == "s3"
    assert cat.filetype is None
