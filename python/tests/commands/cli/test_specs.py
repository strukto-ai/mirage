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

import importlib.metadata
import textwrap

import pytest

from mirage.commands.cli import specs
from mirage.commands.cli.specs import (cli_spec_for, register_cli_spec,
                                       unregister_cli_spec)
from mirage.commands.cli.types import CLIInvocation, CLISpec
from mirage.io import IOResult


async def noop(inv: CLIInvocation):
    return None, IOResult()


EP_SPEC = CLISpec(name="eptest", subcommands=(CLISpec(name="run", fn=noop), ))


@pytest.fixture
def clean_entry_points(monkeypatch):
    monkeypatch.setattr(specs, "_ENTRY_POINT_SPECS", {})
    monkeypatch.setattr(specs, "_entry_points_loaded", False)


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


def test_builtin_himalaya_resolves_lazily():
    spec = cli_spec_for("himalaya")
    assert isinstance(spec, CLISpec)
    assert spec.name == "himalaya"
    assert spec.config_model is not None


def test_builtin_name_cannot_be_shadowed():
    spec = CLISpec(name="himalaya",
                   subcommands=(CLISpec(name="run", fn=noop), ))
    with pytest.raises(ValueError, match="already registered"):
        register_cli_spec(spec)


def test_unknown_key_lists_builtins():
    with pytest.raises(ValueError, match="himalaya"):
        cli_spec_for("spectest5")


def test_reference_form_loads_a_module_dotpath():
    spec = cli_spec_for("tests.commands.cli.test_specs:EP_SPEC")
    assert spec is EP_SPEC


def test_reference_form_loads_a_script_file(tmp_path):
    script = tmp_path / "pager.py"
    script.write_text(
        textwrap.dedent("""\
            from mirage.commands.cli.types import CLIInvocation, CLISpec
            from mirage.io import IOResult


            async def page(inv: CLIInvocation):
                return None, IOResult()


            PAGER = CLISpec(name="pager",
                            subcommands=(CLISpec(name="on", fn=page), ))
            """))
    spec = cli_spec_for(f"{script}:PAGER")
    assert isinstance(spec, CLISpec)
    assert spec.name == "pager"


def test_reference_to_a_non_spec_fails_loud():
    with pytest.raises(TypeError, match="is not a CLISpec"):
        cli_spec_for("tests.commands.cli.test_specs:noop")


def test_entry_point_discovery(clean_entry_points, monkeypatch):
    ep = importlib.metadata.EntryPoint(
        name="epcli",
        value="tests.commands.cli.test_specs:EP_SPEC",
        group="mirage.clis",
    )

    def fake_entry_points(*, group):
        assert group == "mirage.clis"
        return [ep]

    monkeypatch.setattr(importlib.metadata, "entry_points", fake_entry_points)
    assert cli_spec_for("epcli") is EP_SPEC


def test_entry_point_does_not_shadow_builtin(clean_entry_points, monkeypatch):
    ep = importlib.metadata.EntryPoint(
        name="himalaya",
        value="tests.commands.cli.test_specs:EP_SPEC",
        group="mirage.clis",
    )
    monkeypatch.setattr(importlib.metadata, "entry_points",
                        lambda *, group: [ep])
    spec = cli_spec_for("himalaya")
    assert spec is not EP_SPEC
    assert spec.name == "himalaya"


def test_unknown_key_lists_entry_points(clean_entry_points, monkeypatch):
    ep = importlib.metadata.EntryPoint(
        name="epcli",
        value="tests.commands.cli.test_specs:EP_SPEC",
        group="mirage.clis",
    )
    monkeypatch.setattr(importlib.metadata, "entry_points",
                        lambda *, group: [ep])
    with pytest.raises(ValueError, match="epcli"):
        cli_spec_for("spectest6")
