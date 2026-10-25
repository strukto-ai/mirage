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
from mirage.utils.abort import ABORT_JOIN_SECONDS
from mirage.utils.clock import Clock, SystemClock
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
        clock (Clock | None): the workspace's clock, which each install's
            accessor reads time and waits on; None is the system clock.
    """

    def __init__(
        self,
        peers: Callable[[], Iterable[Accessor]] = tuple,
        clock: Clock | None = None,
    ) -> None:
        self._installs: dict[str, CLIInstall] = {}
        self._peers = peers
        self._clock: Clock = clock if clock is not None else SystemClock()
        self._clocks_bound = False
        self._retiring: dict[int, asyncio.Task[None]] = {}
        self._shutdown = asyncio.Event()

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
                spec's ``config_model``, or an instance of that model or
                of a subclass of it, narrowed to the model's fields.
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
        if self._clocks_bound:
            accessor.bind_clock(self._clock, id(install))
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
        since pydantic validated it when it was built. An instance of a
        subclass (a mount config such as ``GDocsConfig`` handed to
        ``gws``) is narrowed to the fields ``config_model`` declares:
        kept whole, its extra fields would ride into every snapshot and
        copy, whose reinstall validates them as a mapping and refuses
        them. A subclass field the caller set is refused as an unknown
        key, as the mapping arm and the TypeScript twin refuse it, so a
        setting the CLI cannot honor is never dropped silently. Any other
        value that is not a mapping is refused by type, rather than
        having its iteration read as a list of unknown keys.

        Args:
            name (str): installed head word, for error attribution.
            spec (CLI): the program tree carrying ``config_model``.
            config (Mapping[str, JsonValue] | BaseModel | None): a raw
                config mapping, or an instance of ``config_model`` or
                of a subclass of it.
        """
        model = spec.config_model
        if model is not None and isinstance(config, model):
            if type(config) is model:
                return config
            unknown = config.model_fields_set - model.model_fields.keys()
            if unknown:
                names = ", ".join(sorted(unknown))
                raise ValueError(f"CLI {name!r}: unknown config keys: {names}")
            config = {
                field: getattr(config, field) for field in model.model_fields
            }
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
        # By field name, the spelling the unknown-key check and a narrowed
        # subclass instance both use, so an aliased field still installs.
        try:
            return model.model_validate(dict(config or {}), by_name=True)
        except ValidationError as exc:
            # An account CLI's config is where a fetched credential
            # lands, the same as a mount's, and the create route answers
            # `str(e)` as its 400 detail: pydantic's own rendering would
            # hand the refused value back. Field and type only, chain
            # cut, the way `build_vfs` reports its config class.
            raise ValueError(f"CLI {name!r}: {error_summary(exc)}") from None

    def bind_clocks(self) -> None:
        """Hand every install's accessor the workspace clock, once the
        workspace is built; an install made later takes it at once. Each
        install holds on its own, so removing one leaves another that
        shares its client holding.

        Raises:
            ValueError: another workspace holds a client on another
                clock; nothing stays bound.
        """
        try:
            for install in self._installs.values():
                install.accessor.bind_clock(self._clock, id(install))
        except BaseException:
            self.release_clocks()
            raise
        self._clocks_bound = True

    def release_clocks(self) -> None:
        """Let go of the workspace clock on every install's accessor, as
        the workspace closes or fails to come to be."""
        self._clocks_bound = False
        for install in self._installs.values():
            install.accessor.release_clock(id(install))

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
        closing = asyncio.create_task(_retire(install, self._shutdown))
        self._retiring[identity] = closing
        try:
            await asyncio.shield(closing)
        finally:
            if closing.done():
                self._retiring.pop(identity, None)

    async def close(self) -> None:
        """Close every install's accessor, including the ones still
        being removed, as the workspace closes; one failed close does not
        skip the rest.

        The workspace cancels its lines before this runs, so a line still
        on an install is unwinding: it gets ``ABORT_JOIN_SECONDS`` to
        finish before its accessor goes, rather than meeting a closed
        client mid-request, and no longer, so one that never settles
        cannot hold the workspace open. Each close is a tracked task, as
        a removal is, so a caller cancelled mid-close leaves it running
        and a retried close waits for it.
        """
        shutdown, self._shutdown = self._shutdown, asyncio.Event()
        shutdown.set()
        installs = list(self._installs.values())
        self._installs.clear()
        for install in installs:
            self._retiring[id(install)] = asyncio.create_task(
                _close_after_grace(install)
            )
        closing = list(self._retiring.items())
        results = await asyncio.gather(
            *(asyncio.shield(task) for _, task in closing),
            return_exceptions=True,
        )
        for identity, task in closing:
            if task.done():
                self._retiring.pop(identity, None)
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


async def _retire(install: CLIInstall, shutdown: asyncio.Event) -> None:
    idle = asyncio.create_task(install.activity.wait())
    stopping = asyncio.create_task(shutdown.wait())
    try:
        done, _ = await asyncio.wait(
            {idle, stopping}, return_when=asyncio.FIRST_COMPLETED
        )
    finally:
        idle.cancel()
        stopping.cancel()
        await asyncio.gather(idle, stopping, return_exceptions=True)
    try:
        if idle in done:
            await install.accessor.close()
        else:
            await _close_after_grace(install)
    finally:
        install.accessor.release_clock(id(install))


async def _close_after_grace(install: CLIInstall) -> None:
    idle = asyncio.ensure_future(install.activity.wait())
    try:
        await asyncio.wait({idle}, timeout=ABORT_JOIN_SECONDS)
    finally:
        idle.cancel()
        await asyncio.gather(idle, return_exceptions=True)
    try:
        await install.accessor.close()
    finally:
        install.accessor.release_clock(id(install))
