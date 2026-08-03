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

from pydantic import BaseModel

from mirage.commands.cli.types import CLISpec
from mirage.commands.spec import SPECS
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.names import (JOB_BUILTINS, NAMESPACE_COMMANDS,
                                    SHELL_NAMES)


class CLIRegistry:
    """Installed CLIs, keyed by head word.

    Fully separate from the mount registry: a CLI exists because it was
    installed (YAML ``clis:`` section or ``register_cli``), never
    because storage was mounted. Install is fail-loud: a bad name, a
    colliding name, or a config the spec's ``config_model`` rejects
    raises at install time, so a workspace that loads has only valid
    entries.
    """

    def __init__(self) -> None:
        self._installs: dict[str, CLIInstall] = {}

    def install(self,
                name: str,
                spec: CLISpec,
                config: dict[str, object] | None = None) -> CLIInstall:
        """Install a CLI under a head word.

        Args:
            name (str): head word to install under. Must be a single
                word and must not collide with another installed CLI, a
                shell builtin, or a general command (a runtime capture
                of the same name is fine: the policy steers per line).
            spec (CLISpec): the program tree.
            config (dict[str, object] | None): installation config,
                validated through the spec's ``config_model``.
        """
        if not name or any(ch.isspace() for ch in name):
            raise ValueError(f"CLI name {name!r} must be a single word")
        if name in self._installs:
            raise ValueError(f"CLI name {name!r} is already installed")
        if name in SHELL_NAMES or name in JOB_BUILTINS:
            raise ValueError(f"CLI name {name!r} collides with a shell "
                             f"builtin")
        if name in NAMESPACE_COMMANDS or name in SPECS:
            raise ValueError(f"CLI name {name!r} collides with a general "
                             f"command")
        validated = self._validate_config(name, spec, config)
        install = CLIInstall(name=name, spec=spec, config=validated)
        self._installs[name] = install
        return install

    def _validate_config(self, name: str, spec: CLISpec,
                         config: dict[str, object] | None) -> BaseModel | None:
        """Validate an installation config against the spec's model.

        Args:
            name (str): installed head word, for error attribution.
            spec (CLISpec): the program tree carrying ``config_model``.
            config (dict[str, object] | None): raw config mapping.
        """
        if spec.config_model is None:
            if config:
                raise ValueError(f"CLI {name!r}: config given but "
                                 f"{spec.name!r} declares no config_model")
            return None
        model = spec.config_model
        # Unknown keys fail loud (a typo'd YAML key must not be
        # silently ignored) unless the model itself opts into extras.
        if model.model_config.get("extra") != "allow":
            unknown = set(config or {}) - set(model.model_fields)
            if unknown:
                names = ", ".join(sorted(unknown))
                raise ValueError(f"CLI {name!r}: unknown config keys: "
                                 f"{names}")
        return model(**(config or {}))

    def uninstall(self, name: str) -> None:
        """Remove an installed CLI; its head word stops resolving (127).

        Args:
            name (str): installed head word.
        """
        if name not in self._installs:
            raise KeyError(f"CLI name {name!r} is not installed")
        del self._installs[name]

    def get(self, name: str) -> CLIInstall | None:
        """Look up an installation by head word.

        Args:
            name (str): candidate head word.
        """
        return self._installs.get(name)

    def items(self) -> dict[str, CLIInstall]:
        """Snapshot of the installed CLIs keyed by head word."""
        return dict(self._installs)

    def names(self) -> frozenset[str]:
        """The installed head words."""
        return frozenset(self._installs)
