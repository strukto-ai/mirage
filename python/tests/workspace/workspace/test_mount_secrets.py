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
from pydantic import BaseModel, ConfigDict

from mirage import Workspace
from mirage.config import load_config, resolve_secrets
from mirage.core.slack.config import SlackConfig
from mirage.resource.slack import SlackResource
from mirage.secrets import registry
from mirage.secrets.config import SecretRef, SecretSource
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import register_secrets
from mirage.secrets.sources import resolve_config_secrets, resolve_sources
from mirage.secrets.types import ResolvedSecret

CALLS: list[tuple[str, str]] = []

BOT = SecretRef(provider="op",
                ref="op://mirage/SLACK_BOT_TOKEN",
                key="credential")
USER = SecretRef(provider="op",
                 ref="op://mirage/SLACK_USER_TOKEN",
                 key="credential")


class DemoConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    account: str = "default"


async def fetch_demo(config: DemoConfig, ref: str) -> ResolvedSecret:
    CALLS.append((config.account, ref))
    if ref.endswith("MISSING"):
        raise RuntimeError("no item at /host/vault.sqlite")
    return ResolvedSecret(
        fields={"credential": f"xoxb-{ref.rsplit('/', 1)[-1]}"})


@pytest.fixture(autouse=True)
def fresh_custom(monkeypatch):
    CALLS.clear()
    monkeypatch.setattr(registry, "_CUSTOM", {})
    register_secrets("demo", DemoConfig, fetch_demo)


async def demo_sources(account: str = "team"):
    return await resolve_sources(
        {"op": SecretSource(source="demo", config={"account": account})})


def yaml_config(**config):
    return load_config(
        {
            "mode": "READ",
            "mounts": {
                "/slack": {
                    "resource": "slack",
                    "config": config
                }
            },
            "secrets": {
                "op": {
                    "source": "demo",
                    "config": {
                        "account": "yaml"
                    }
                }
            },
        },
        env={},
    )


@pytest.mark.asyncio
async def test_the_yaml_door_resolves_a_mount_pointer():
    cfg = await resolve_secrets(
        yaml_config(token=BOT.model_dump(by_alias=True)))
    ws = Workspace(**cfg.to_workspace_kwargs())
    token = ws._registry.mount_for_prefix("/slack").resource.config.token
    # The credential field never sees a pointer: it is fetched before
    # `build_resource`, which is why that door can stay sync.
    assert token.get_secret_value() == "xoxb-SLACK_BOT_TOKEN"
    assert CALLS == [("yaml", "op://mirage/SLACK_BOT_TOKEN")]
    await ws.close()


@pytest.mark.asyncio
async def test_a_yaml_literal_needs_no_source_and_no_fetch():
    cfg = await resolve_secrets(yaml_config(token="xoxb-literal"))
    ws = Workspace(**cfg.to_workspace_kwargs())
    token = ws._registry.mount_for_prefix("/slack").resource.config.token
    assert token.get_secret_value() == "xoxb-literal"
    assert CALLS == []
    await ws.close()


@pytest.mark.asyncio
async def test_a_config_with_no_sources_declared_needs_no_fetch():
    cfg = load_config(
        {
            "mode": "READ",
            "mounts": {
                "/slack": {
                    "resource": "slack",
                    "config": {
                        "token": "xoxb-literal"
                    }
                }
            },
        },
        env={},
    )
    assert await resolve_secrets(cfg) == cfg
    assert CALLS == []


@pytest.mark.asyncio
async def test_a_pointer_needs_no_secrets_block_to_name_a_builtin_source(
        monkeypatch):
    # `fetch_secret` builds an undeclared builtin from ambient
    # defaults, so a deployment with one account writes no block.
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-ambient")
    cfg = await resolve_secrets(
        load_config(
            {
                "mode": "READ",
                "mounts": {
                    "/slack": {
                        "resource": "slack",
                        "config": {
                            "token": {
                                "from": "env",
                                "key": "SLACK_BOT_TOKEN"
                            }
                        }
                    }
                },
            },
            env={},
        ))
    ws = Workspace(**cfg.to_workspace_kwargs())
    token = ws._registry.mount_for_prefix("/slack").resource.config.token
    assert token.get_secret_value() == "xoxb-ambient"
    await ws.close()


@pytest.mark.asyncio
async def test_an_application_mixes_a_vanilla_token_and_a_remote_one():
    sources = await demo_sources()
    remote = await resolve_config_secrets({"token": BOT}, sources)
    from_remote = SlackResource(config=SlackConfig(**remote))
    from_dotenv = SlackResource(config=SlackConfig(token="xoxb-from-dotenv"))
    assert from_remote.config.token.get_secret_value() == (
        "xoxb-SLACK_BOT_TOKEN")
    assert from_dotenv.config.token.get_secret_value() == "xoxb-from-dotenv"


@pytest.mark.asyncio
async def test_a_literal_and_a_pointer_coexist_in_one_config():
    sources = await demo_sources()
    out = await resolve_config_secrets(
        {
            "token": "xoxb-literal",
            "search_token": USER
        }, sources)
    assert out["token"] == "xoxb-literal"
    assert out["search_token"] == "xoxb-SLACK_USER_TOKEN"


@pytest.mark.asyncio
async def test_two_fields_on_one_secret_cost_one_fetch():
    sources = await demo_sources()
    await resolve_config_secrets(
        {
            "token": BOT,
            "search_token": BOT.model_copy(update={"key": "credential"})
        }, sources)
    assert CALLS == [("team", "op://mirage/SLACK_BOT_TOKEN")]


@pytest.mark.asyncio
async def test_an_unreachable_secret_is_reported_redacted():
    sources = await demo_sources()
    missing = SecretRef(provider="op",
                        ref="op://mirage/MISSING",
                        key="credential")
    with pytest.raises(SecretsError) as err:
        await resolve_config_secrets({"token": missing}, sources,
                                     "mounts./slack.config")
    assert "mounts./slack.config.token: cannot fetch from op" in str(err.value)
    # The source's own words name a host path; they go to the log.
    assert "/host/vault.sqlite" not in str(err.value)


@pytest.mark.asyncio
async def test_a_cli_config_reads_a_pointer_too():
    cfg = load_config(
        {
            "mode": "READ",
            "mounts": {},
            "clis": {
                "demo": {
                    "cli": "git",
                    "config": {
                        "token": BOT.model_dump(by_alias=True)
                    },
                }
            },
            "secrets": {
                "op": {
                    "source": "demo",
                    "config": {
                        "account": "cli"
                    }
                }
            },
        },
        env={},
    )
    out = await resolve_secrets(cfg)
    assert out.clis["demo"].config["token"] == "xoxb-SLACK_BOT_TOKEN"
    assert CALLS == [("cli", "op://mirage/SLACK_BOT_TOKEN")]


@pytest.mark.asyncio
async def test_a_config_with_no_pointer_builds_no_source():
    """A declared source whose only readers are lazy managed variables
    must not be built at config load: that reads its bootstrap pointers,
    and a dotenv momentarily unreadable would stop the workspace from
    being created at all."""
    cfg = yaml_config(token="xoxb-literal")
    out = await resolve_secrets(cfg)
    assert out.mounts["/slack"].config["token"] == "xoxb-literal"
    assert CALLS == []


@pytest.mark.asyncio
async def test_a_config_with_a_pointer_still_builds_its_sources():
    cfg = yaml_config(token=BOT.model_dump(by_alias=True))
    out = await resolve_secrets(cfg)
    assert out.mounts["/slack"].config["token"] == "xoxb-SLACK_BOT_TOKEN"
    assert CALLS == [("yaml", "op://mirage/SLACK_BOT_TOKEN")]


@pytest.mark.asyncio
async def test_a_nested_pointer_still_builds_its_sources():
    """The scan recurses, so a pointer under a mapping or a list counts."""
    cfg = yaml_config(token=[{"inner": BOT.model_dump(by_alias=True)}])
    await resolve_secrets(cfg)
    assert CALLS == [("yaml", "op://mirage/SLACK_BOT_TOKEN")]
