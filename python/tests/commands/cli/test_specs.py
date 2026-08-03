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

from mirage.commands.cli.specs import (cli_spec_for, register_cli_spec,
                                       unregister_cli_spec)
from mirage.commands.cli.types import CLISpec
from mirage.io import IOResult


async def noop(config, paths, *texts, **flags):
    return None, IOResult()


def test_register_resolve_unregister():
    spec = CLISpec(name="spectest",
                   subcommands=(CLISpec(name="run", fn=noop), ))
    register_cli_spec(spec)
    try:
        assert cli_spec_for("spectest") is spec
    finally:
        unregister_cli_spec("spectest")
    with pytest.raises(ValueError, match="unknown cli 'spectest'"):
        cli_spec_for("spectest")


def test_duplicate_registration_is_refused():
    spec = CLISpec(name="spectest2",
                   subcommands=(CLISpec(name="run", fn=noop), ))
    register_cli_spec(spec)
    try:
        with pytest.raises(ValueError, match="already registered"):
            register_cli_spec(spec)
    finally:
        unregister_cli_spec("spectest2")


def test_unregister_unknown_raises():
    with pytest.raises(KeyError, match="not registered"):
        unregister_cli_spec("spectest3")


def test_unknown_key_names_the_known_specs():
    with pytest.raises(ValueError, match="known: "):
        cli_spec_for("spectest4")
