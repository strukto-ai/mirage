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

from collections.abc import Mapping
from importlib import import_module
from typing import NamedTuple

from pydantic import BaseModel

from mirage.secrets.constants import BUILTINS
from mirage.secrets.errors import SecretsError
from mirage.secrets.types import ResolvedSecret, ResolvedSource, SecretFetchFn


class SourceEntry(NamedTuple):
    """One resolvable source: its config model and its fetch function."""
    config_model: type[BaseModel]
    fetch: SecretFetchFn


_CUSTOM: dict[str, SourceEntry] = {}


def register_secrets(name: str, config_model: type[BaseModel],
                     fetch: SecretFetchFn) -> None:
    """Register a secrets source under a name.

    Host-side only, like ``register_cli``: the embedding program calls
    it, never a line the agent types. A source is one config model plus
    one async function; there is no Provider class. Registering an
    existing name replaces it, builtins included -- the host owns both
    sides of this registry, so shadowing ``env`` is a deployment
    decision, not an escalation.

    Args:
        name (str): the name managed env entries spell in ``from``.
        config_model (type[BaseModel]): the source's config model.
        fetch (SecretFetchFn): async ``(config, ref) -> ResolvedSecret``.
    """
    _CUSTOM[name] = SourceEntry(config_model, fetch)


def known_sources() -> list[str]:
    """Every name ``source_for`` can resolve, builtin and registered."""
    return sorted({*BUILTINS, *_CUSTOM})


def source_for(name: str) -> SourceEntry:
    """Resolve a source name to its config model and fetch function.

    Custom registrations win over builtins; a builtin's fetcher module
    imports on first use.

    Args:
        name (str): a managed env entry's ``from`` value.

    Raises:
        SecretsError: ``name`` is neither registered nor builtin, or
            the builtin's optional dependency is not installed (each
            builtin's extra is named after the source).
    """
    entry = _CUSTOM.get(name)
    if entry is not None:
        return entry
    builtin = BUILTINS.get(name)
    if builtin is None:
        raise SecretsError(
            f"unknown secrets source {name!r}; known: {known_sources()}")
    config_model, fetch_path = builtin
    module_name, _, attr = fetch_path.partition(":")
    try:
        module = import_module(module_name)
    except ModuleNotFoundError as exc:
        raise SecretsError(
            f"the {name!r} source needs its optional dependency "
            f"({exc.name}): pip install 'mirage-ai[{name}]'") from exc
    return SourceEntry(config_model, getattr(module, attr))


async def fetch_secret(
        source: str,
        ref: str,
        sources: Mapping[str, ResolvedSource] | None = None) -> ResolvedSecret:
    """Fetch one secret from a named source.

    The whole call path: resolve the source, take its config, run its
    fetch. Pure and module-level -- there is no resolver class, and no
    cache: fetched values live only on session vars.

    ``source`` names a declared instance first and a source second, so
    a deployment with one account of a platform can leave the
    ``secrets:`` block out entirely and still spell ``from: aws-sm``.
    An undeclared name builds its config from ambient defaults, which
    is what every source did before the block existed.

    Args:
        source (str): a managed env entry's ``from`` value: an instance
            name, or a source name for the ambient default.
        ref (str): the source's address for the secret.
        sources (Mapping[str, ResolvedSource] | None): the workspace's
            declared instances, already built.

    Raises:
        SecretsError: the source is unknown, its dependency is missing,
            or its fetch refused the ref.
    """
    entry = sources.get(source) if sources else None
    if entry is not None:
        return await entry.fetch(entry.config, ref)
    config_model, fetch = source_for(source)
    return await fetch(config_model(), ref)
