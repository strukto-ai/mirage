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

from mirage.commands.cli.types import CLISpec

# Named CLISpec trees the YAML ``clis:`` section resolves against
# (``cli: slack`` looks up "slack" here). Bundled programs register at
# import time; user programs register through register_cli_spec before
# the workspace loads.
CLI_SPECS: dict[str, CLISpec] = {}


def register_cli_spec(spec: CLISpec) -> None:
    """Make a CLISpec resolvable by name from YAML.

    Args:
        spec (CLISpec): a program tree; its root ``name`` is the key.
    """
    if spec.name in CLI_SPECS:
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
    if name not in CLI_SPECS:
        known = ", ".join(sorted(CLI_SPECS)) or "none registered"
        raise ValueError(f"unknown cli {name!r} (known: {known})")
    return CLI_SPECS[name]
