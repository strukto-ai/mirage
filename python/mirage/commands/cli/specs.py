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

import importlib

from mirage.commands.cli.types import CLISpec

# Named CLISpec trees the YAML ``clis:`` section resolves against
# (``cli: slack`` looks up "slack" here). User programs register through
# register_cli_spec before the workspace loads.
CLI_SPECS: dict[str, CLISpec] = {}

# Bundled program trees, resolved lazily like the resource registry:
# the modules pull optional extras (himalaya needs the email stack), so
# they must not import until the name is actually requested.
BUILTIN_CLI_SPECS: dict[str, str] = {
    "discord": "mirage.commands.cli.builtin.discord:DISCORD",
    "gws": "mirage.commands.cli.builtin.gws:GWS",
    "himalaya": "mirage.commands.cli.builtin.himalaya:HIMALAYA",
    "linear": "mirage.commands.cli.builtin.linear:LINEAR",
    "ntn": "mirage.commands.cli.builtin.ntn:NTN",
    "slack": "mirage.commands.cli.builtin.slack:SLACK",
}


def _load_builtin(ref: str) -> CLISpec:
    module_name, _, attr = ref.partition(":")
    module = importlib.import_module(module_name)
    spec = getattr(module, attr)
    if not isinstance(spec, CLISpec):
        raise TypeError(f"builtin CLI ref {ref!r} is not a CLISpec")
    return spec


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
    """Resolve a YAML ``cli:`` key to its registered tree, fail loud.

    Args:
        name (str): the spec's root name.
    """
    if name in CLI_SPECS:
        return CLI_SPECS[name]
    if name in BUILTIN_CLI_SPECS:
        return _load_builtin(BUILTIN_CLI_SPECS[name])
    known = ", ".join(sorted(set(CLI_SPECS) | set(BUILTIN_CLI_SPECS)))
    raise ValueError(
        f"unknown cli {name!r} (known: {known or 'none registered'})")
