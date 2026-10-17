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

import asyncio
from collections.abc import Callable, Iterable, Mapping

from pydantic import BaseModel, ValidationError

from mirage.accessor.base import Accessor
from mirage.commands.cli.types import CLI
from mirage.commands.spec import SPECS
from mirage.secrets.summary import error_summary
from mirage.types import JsonValue
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.lookup.constants import (
    JOB_BUILTINS,
    KEYWORDS,
    NAMESPACE_COMMANDS,
    SHELL_NAMES,
)


class CLIRegistry:
    """Installed CLIs, keyed by head word.

    Fully separate from the mount registry: a CLI exists because it was
    installed (YAML ``clis:`` section or ``register_cli``), never
    because storage was mounted. Install is fail-loud: a bad name, a
    colliding name, or a config the spec's ``config_model`` rejects
    raises at install time, so a workspace that loads has only valid
    entries.

    The lifecycle is host-side only, and must stay that way: install and
    uninstall are called by the program embedding mirage, never by a
    line the agent types, so an agent cannot take away the tools it was
    given. Do not add an ``install``/``uninstall`` shell builtin. What
    an agent can do is shadow a head word with a shell function, which
    is bash's own rule, reversible with ``unset -f``, bypassable with
    ``command <name>``, and visible through ``type -a``. Pinning a head
    word against that belongs in the policy layer's ``pre_command``,
    since it is a per-deployment call rather than a property of the
    registry.

    Args:
        peers (Callable[[], Iterable[Accessor]]): the mounts' accessors,
            which a new install's accessor may share an account with.
    """

    def __init__(
        self, peers: Callable[[], Iterable[Accessor]] = tuple
    ) -> None:
        self._installs: dict[str, CLIInstall] = {}
        self._peers = peers
        self._retiring: dict[int, asyncio.Task[None]] = {}

    def install(
        self,
        name: str,
        spec: CLI,
        config: Mapping[str, JsonValue] | BaseModel | None = None,
    ) -> CLIInstall:
        """Install a CLI under a head word.

        Args:
            name (str): head word to install under. Must be a single
                word and must not collide with another installed CLI, a
                shell builtin, or a general command (a runtime capture
                of the same name is fine: the policy steers per line).
            spec (CLI): the program tree.
            config (Mapping[str, JsonValue] | BaseModel | None):
                installation config: a mapping, validated through the
                spec's ``config_model``, or an instance of that model.
        """
        if not name or any(ch.isspace() for ch in name):
            raise ValueError(f"CLI name {name!r} must be a single word")
        if name in self._installs:
            raise ValueError(f"CLI name {name!r} is already installed")
        if name in SHELL_NAMES or name in JOB_BUILTINS:
            raise ValueError(
                f"CLI name {name!r} collides with a shell builtin"
            )
        # A reserved word never reaches dispatch (the parser consumes it),
        # so an install under one would be unreachable rather than wrong.
        if name in KEYWORDS:
            raise ValueError(f"CLI name {name!r} is a shell keyword")
        if name in NAMESPACE_COMMANDS or name in SPECS:
            raise ValueError(
                f"CLI name {name!r} collides with a general command"
            )
        validated = self._validate_config(name, spec, config)
        accessor = spec.accessor(validated)
        accessor.join(
            [*self._peers(), *(i.accessor for i in self._installs.values())]
        )
        install = CLIInstall(
            name=name, cli=spec, config=validated, accessor=accessor
        )
        self._installs[name] = install
        return install

    def _validate_config(
        self,
        name: str,
        spec: CLI,
        config: Mapping[str, JsonValue] | BaseModel | None,
    ) -> BaseModel | dict[str, JsonValue] | None:
        """Validate an installation config against the spec's model.

        An instance of the spec's own ``config_model`` is taken as it is,
        since pydantic validated it when it was built; any other value
        that is not a mapping is refused by type, rather than having its
        iteration read as a list of unknown keys.

        Args:
            name (str): installed head word, for error attribution.
            spec (CLI): the program tree carrying ``config_model``.
            config (Mapping[str, JsonValue] | BaseModel | None): a raw
                config mapping, or an instance of ``config_model``.
        """
        model = spec.config_model
        if model is not None and isinstance(config, model):
            return config
        if config is not None and not isinstance(config, Mapping):
            expected = (
                "a mapping"
                if model is None
                else f"a mapping or a {model.__name__}"
            )
            raise ValueError(
                f"CLI {name!r}: config must be {expected}, "
                f"got {type(config).__name__}"
            )
        if spec.script is not None:
            # A script spec has no config_model: the mapping passes
            # through as-is for the program to consume.
            return dict(config) if config else None
        if model is None:
            if config:
                raise ValueError(
                    f"CLI {name!r}: config given but "
                    f"{spec.spec.name!r} declares no config_model"
                )
            return None
        # Unknown keys fail loud (a typo'd YAML key must not be
        # silently ignored) unless the model itself opts into extras.
        if model.model_config.get("extra") != "allow":
            unknown = set(config or {}) - set(model.model_fields)
            if unknown:
                names = ", ".join(sorted(unknown))
                raise ValueError(f"CLI {name!r}: unknown config keys: {names}")
        try:
            return model(**(config or {}))
        except ValidationError as exc:
            # An account CLI's config is where a fetched credential
            # lands, the same as a mount's, and the create route answers
            # `str(e)` as its 400 detail: pydantic's own rendering would
            # hand the refused value back. Field and type only, chain
            # cut, the way `build_vfs` reports its config class.
            raise ValueError(f"CLI {name!r}: {error_summary(exc)}") from None

    async def uninstall(self, name: str) -> None:
        """Remove an installed CLI now and close its accessor once the
        lines running on it and their output streams are done; its head
        word stops resolving (127) at once.

        Args:
            name (str): installed head word.
        """
        install = self._installs.pop(name, None)
        if install is None:
            raise KeyError(f"CLI name {name!r} is not installed")
        identity = id(install)
        closing = asyncio.create_task(_retire(install))
        self._retiring[identity] = closing
        try:
            await asyncio.shield(closing)
        finally:
            if closing.done():
                self._retiring.pop(identity, None)

    async def close(self) -> None:
        """Close every install's accessor, including the ones still
        being removed, as the workspace closes; one failed close does not
        skip the rest."""
        installs = list(self._installs.values())
        self._installs.clear()
        results = await asyncio.gather(
            *(install.accessor.close() for install in installs),
            *(asyncio.shield(task) for task in self._retiring.values()),
            return_exceptions=True,
        )
        failures = [r for r in results if isinstance(r, BaseException)]
        if failures:
            raise (
                failures[0]
                if len(failures) == 1
                else BaseExceptionGroup("CLI close failed", failures)
            )

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


async def _retire(install: CLIInstall) -> None:
    await install.activity.wait()
    await install.accessor.close()
