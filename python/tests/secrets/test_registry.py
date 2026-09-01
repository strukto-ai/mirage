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

import sys
import types

import pytest
from pydantic import BaseModel, ConfigDict

from mirage.secrets import registry
from mirage.secrets.config import AWSSMConfig, DotenvConfig, EnvConfig
from mirage.secrets.constants import BUILTINS
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import (fetch_secret, known_sources,
                                     register_secrets, source_for)
from mirage.secrets.types import ResolvedSecret, ResolvedSource


class VaultConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


async def fetch_vault(config: VaultConfig, ref: str) -> ResolvedSecret:
    return ResolvedSecret(fields={"token": "t"})


async def fetch_override(config: VaultConfig, ref: str) -> ResolvedSecret:
    return ResolvedSecret(fields={})


@pytest.fixture(autouse=True)
def fresh_custom(monkeypatch):
    monkeypatch.setattr(registry, "_CUSTOM", {})


def test_custom_registration_resolves():
    register_secrets("vault", VaultConfig, fetch_vault)
    assert source_for("vault") == (VaultConfig, fetch_vault)


def test_custom_registration_wins_over_a_builtin():
    register_secrets("env", VaultConfig, fetch_override)
    assert source_for("env") == (VaultConfig, fetch_override)


def test_reregistering_a_custom_name_replaces_it():
    register_secrets("vault", VaultConfig, fetch_vault)
    register_secrets("vault", VaultConfig, fetch_override)
    assert source_for("vault") == (VaultConfig, fetch_override)


def test_unknown_source_raises_naming_the_known_ones():
    register_secrets("vault", VaultConfig, fetch_vault)
    with pytest.raises(SecretsError) as err:
        source_for("nope")
    message = str(err.value)
    assert "nope" in message
    for name in ("env", "dotenv", "aws-sm", "vault"):
        assert name in message


def test_known_sources_merges_builtin_and_custom():
    register_secrets("vault", VaultConfig, fetch_vault)
    assert known_sources() == ["1password", "aws-sm", "dotenv", "env", "vault"]


def test_builtin_resolves_lazily_through_the_table(monkeypatch):
    module = types.ModuleType("fake_secrets_source")
    module.fetch = fetch_vault
    monkeypatch.setitem(sys.modules, "fake_secrets_source", module)
    monkeypatch.setitem(BUILTINS, "dotenv",
                        (DotenvConfig, "fake_secrets_source:fetch"))
    assert source_for("dotenv") == (DotenvConfig, fetch_vault)


def test_missing_optional_dependency_names_the_extra(monkeypatch):
    monkeypatch.setitem(BUILTINS, "dotenv",
                        (DotenvConfig, "mirage_no_such_module:fetch"))
    with pytest.raises(SecretsError, match=r"mirage-ai\[dotenv\]"):
        source_for("dotenv")


def test_builtin_table_resolves_the_real_fetchers():
    for name, config_model in (("env", EnvConfig), ("dotenv", DotenvConfig),
                               ("aws-sm", AWSSMConfig)):
        resolved_model, fetch = source_for(name)
        assert resolved_model is config_model, name
        assert callable(fetch), name


@pytest.mark.asyncio
async def test_fetch_secret_constructs_the_config_and_passes_the_ref():
    calls = []

    async def fetch(config: VaultConfig, ref: str) -> ResolvedSecret:
        calls.append((config, ref))
        return ResolvedSecret(fields={"token": "t"})

    register_secrets("vault", VaultConfig, fetch)
    secret = await fetch_secret("vault", "prod/api")
    assert secret.fields == {"token": "t"}
    assert calls == [(VaultConfig(), "prod/api")]


@pytest.mark.asyncio
async def test_fetch_secret_unknown_source_raises():
    with pytest.raises(SecretsError, match="unknown secrets source"):
        await fetch_secret("nope", "r")


@pytest.mark.asyncio
async def test_fetch_secret_prefers_a_declared_instance():
    seen: list[str] = []

    async def fetch(config: VaultConfig, ref: str) -> ResolvedSecret:
        seen.append(ref)
        return ResolvedSecret(fields={"token": "instance"})

    register_secrets("vault", VaultConfig, fetch_vault)
    sources = {
        "prod": ResolvedSource(source="vault",
                               config=VaultConfig(),
                               fetch=fetch)
    }
    secret = await fetch_secret("prod", "r", sources)
    assert secret.fields == {"token": "instance"}
    assert seen == ["r"]


@pytest.mark.asyncio
async def test_fetch_secret_falls_back_to_the_source_of_that_name():
    register_secrets("vault", VaultConfig, fetch_vault)
    sources = {
        "prod":
        ResolvedSource(source="vault",
                       config=VaultConfig(),
                       fetch=fetch_override)
    }
    secret = await fetch_secret("vault", "r", sources)
    assert secret.fields == {"token": "t"}


@pytest.mark.asyncio
async def test_fetch_secret_with_no_table_is_the_ambient_default():
    register_secrets("vault", VaultConfig, fetch_vault)
    assert (await fetch_secret("vault", "r")).fields == {"token": "t"}
