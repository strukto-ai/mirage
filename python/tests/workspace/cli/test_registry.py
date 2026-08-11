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
from pydantic import BaseModel, ValidationError

from mirage.commands.cli.types import CLISpec
from mirage.io import IOResult
from mirage.workspace.cli.registry import CLIRegistry


class TokenConfig(BaseModel):
    token: str


async def noop(config, paths, *texts, **flags):
    return None, IOResult()


def tree(config_model=None) -> CLISpec:
    return CLISpec(name="prog",
                   config_model=config_model,
                   subcommands=(CLISpec(name="run", fn=noop), ))


def test_install_and_get_and_items():
    reg = CLIRegistry()
    install = reg.install("prog", tree())
    assert reg.get("prog") is install
    assert reg.get("other") is None
    assert reg.items() == {"prog": install}


def test_two_installs_of_one_spec_hold_their_own_configs():
    reg = CLIRegistry()
    spec = tree(TokenConfig)
    eng = reg.install("prog", spec, {"token": "eng"})
    sup = reg.install("prog-sup", spec, {"token": "sup"})
    assert eng.config is not None and eng.config.token == "eng"
    assert sup.config is not None and sup.config.token == "sup"


def test_name_must_be_a_single_word():
    reg = CLIRegistry()
    with pytest.raises(ValueError, match="single word"):
        reg.install("two words", tree())
    with pytest.raises(ValueError, match="single word"):
        reg.install("", tree())


def test_duplicate_name_is_refused():
    reg = CLIRegistry()
    reg.install("prog", tree())
    with pytest.raises(ValueError, match="already installed"):
        reg.install("prog", tree())


def test_shell_builtin_collision_is_refused():
    reg = CLIRegistry()
    with pytest.raises(ValueError, match="shell builtin"):
        reg.install("cd", tree())
    with pytest.raises(ValueError, match="shell builtin"):
        reg.install("kill", tree())


def test_shell_keyword_is_refused():
    # The parser consumes a reserved word, so the install would never be
    # reachable from a line.
    reg = CLIRegistry()
    with pytest.raises(ValueError, match="shell keyword"):
        reg.install("if", tree())
    with pytest.raises(ValueError, match="shell keyword"):
        reg.install("select", tree())


def test_general_command_collision_is_refused():
    reg = CLIRegistry()
    with pytest.raises(ValueError, match="general command"):
        reg.install("grep", tree())
    with pytest.raises(ValueError, match="general command"):
        reg.install("ln", tree())


def test_config_validates_through_the_model_fail_loud():
    reg = CLIRegistry()
    with pytest.raises(ValidationError):
        reg.install("prog", tree(TokenConfig), {})
    with pytest.raises(ValueError, match="unknown config keys: extra"):
        reg.install("prog", tree(TokenConfig), {"token": "x", "extra": 1})


def test_config_without_model_is_refused():
    reg = CLIRegistry()
    with pytest.raises(ValueError, match="declares no config_model"):
        reg.install("prog", tree(), {"token": "x"})


def test_no_config_no_model_installs_with_none():
    reg = CLIRegistry()
    assert reg.install("prog", tree()).config is None


def test_uninstall_removes_and_unknown_raises():
    reg = CLIRegistry()
    reg.install("prog", tree())
    reg.uninstall("prog")
    assert reg.get("prog") is None
    with pytest.raises(KeyError, match="not installed"):
        reg.uninstall("prog")
