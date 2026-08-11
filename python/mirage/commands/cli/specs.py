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
import logging

from mirage.commands.cli.types import CLISpec
from mirage.resource.loader import load_attr

logger = logging.getLogger(__name__)

# Named CLISpec trees the YAML ``clis:`` section resolves against
# (``cli: slack`` looks up "slack" here). User programs register through
# register_cli_spec before the workspace loads.
CLI_SPECS: dict[str, CLISpec] = {}

# Bundled program trees, resolved lazily like the resource registry:
# the modules pull optional extras (himalaya needs the email stack), so
# they must not import until the name is actually requested.
BUILTIN_CLI_SPECS: dict[str, str] = {
    "discord": "mirage.commands.cli.builtin.discord:DISCORD",
    "git": "mirage.commands.cli.builtin.git:GIT",
    "gws": "mirage.commands.cli.builtin.gws:GWS",
    "himalaya": "mirage.commands.cli.builtin.himalaya:HIMALAYA",
    "linear": "mirage.commands.cli.builtin.linear:LINEAR",
    "ntn": "mirage.commands.cli.builtin.ntn:NTN",
    "slack": "mirage.commands.cli.builtin.slack:SLACK",
}

# Any package can ship a CLI by declaring, in its own pyproject.toml::
#
#     [project.entry-points."mirage.clis"]
#     jira = "mypackage.clis:JIRA"
#
# The entry point must resolve to a CLISpec tree. Builtin and
# explicitly registered names win over entry points, mirroring the
# ``mirage.resources`` group.
ENTRY_POINT_GROUP = "mirage.clis"
_ENTRY_POINT_SPECS: dict[str, str] = {}
_entry_points_loaded = False


def _load_ref(ref: str) -> CLISpec:
    spec = load_attr(ref)
    if not isinstance(spec, CLISpec):
        raise TypeError(f"CLI ref {ref!r} is not a CLISpec")
    return spec


def _load_entry_point_clis() -> None:
    global _entry_points_loaded
    if _entry_points_loaded:
        return
    _entry_points_loaded = True
    for ep in importlib.metadata.entry_points(group=ENTRY_POINT_GROUP):
        if ep.name in CLI_SPECS or ep.name in BUILTIN_CLI_SPECS:
            logger.debug("entry point %r shadowed by existing CLI", ep.name)
            continue
        _ENTRY_POINT_SPECS[ep.name] = ep.value


def register_cli_spec(spec: CLISpec) -> None:
    """Make a CLISpec resolvable by name from YAML.

    Args:
        spec (CLISpec): a program tree; its root ``name`` is the key.
    """
    if spec.name in CLI_SPECS or spec.name in BUILTIN_CLI_SPECS:
        raise ValueError(f"CLI spec {spec.name!r} is already registered")
    CLI_SPECS[spec.name] = spec


def unregister_cli_spec(name: str) -> None:
    """Remove a named CLISpec from the YAML lookup.

    Args:
        name (str): the spec's root name.
    """
    if name not in CLI_SPECS:
        raise KeyError(f"CLI spec {name!r} is not registered")
    del CLI_SPECS[name]


def cli_spec_for(name: str) -> CLISpec:
    """Resolve a YAML ``cli:`` value to its program tree, fail loud.

    Resolution order mirrors ``build_resource``: registered names, then
    builtins, then a direct loader reference, then ``mirage.clis``
    entry points from installed packages. A value containing ``:`` is
    the reference form, pointing straight at a CLISpec attribute as
    ``"./my_cli.py:PAGER"`` (script file) or ``"mypackage.clis:JIRA"``
    (module dotpath).

    Args:
        name (str): registered/builtin/entry-point name, or a
            ``"source:ATTR"`` reference.
    """
    if name in CLI_SPECS:
        return CLI_SPECS[name]
    if name in BUILTIN_CLI_SPECS:
        return _load_ref(BUILTIN_CLI_SPECS[name])
    if ":" in name:
        return _load_ref(name)
    _load_entry_point_clis()
    if name in _ENTRY_POINT_SPECS:
        return _load_ref(_ENTRY_POINT_SPECS[name])
    known = ", ".join(
        sorted({*CLI_SPECS, *BUILTIN_CLI_SPECS, *_ENTRY_POINT_SPECS}))
    raise ValueError(
        f"unknown cli {name!r} (known: {known or 'none registered'})")
