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

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource
from mirage.resource.slack import SlackConfig, SlackResource
from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import register_secrets
from mirage.secrets.types import ResolvedSecret
from mirage.server.clone import clone_workspace_with_override


class AccountConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    account: str = "default"


async def fetch_account(config: AccountConfig, ref: str) -> ResolvedSecret:
    return ResolvedSecret(fields={"credential": f"{config.account}:{ref}"})


@pytest.mark.asyncio
async def test_a_clone_keeps_the_declared_instances():
    """State carries the env pointers and never the `secrets:` block
    behind them, so a clone that does not carry the declarations
    answers the first read with an unknown source."""
    register_secrets("acct-clone", AccountConfig, fetch_account)
    src = Workspace(
        {"/": RAMResource()},
        mode=MountMode.WRITE,
        secrets={
            "prod": {
                "source": "acct-clone",
                "config": {
                    "account": "a1"
                },
            }
        },
        env={"TOKEN": {
            "from": "prod",
            "ref": "r",
            "key": "credential"
        }})
    try:
        clone = await clone_workspace_with_override(src, None)
        try:
            result = await clone.execute('echo "$TOKEN"')
            assert result.exit_code == 0
            assert (await result.stdout_str()) == "a1:r\n"
        finally:
            await clone.close()
    finally:
        await src.close()


@pytest.mark.asyncio
async def test_an_override_replaces_the_declared_instances():
    """A staging clone points at its own accounts; keeping the source
    workspace's would leave it reading production."""
    register_secrets("acct-override", AccountConfig, fetch_account)
    src = Workspace(
        {"/": RAMResource()},
        mode=MountMode.WRITE,
        secrets={
            "prod": {
                "source": "acct-override",
                "config": {
                    "account": "live"
                },
            }
        },
        env={"TOKEN": {
            "from": "prod",
            "ref": "r",
            "key": "credential"
        }})
    try:
        clone = await clone_workspace_with_override(
            src, {
                "secrets": {
                    "prod": {
                        "source": "acct-override",
                        "config": {
                            "account": "staging"
                        },
                    }
                }
            })
        try:
            result = await clone.execute('echo "$TOKEN"')
            assert (await result.stdout_str()) == "staging:r\n"
        finally:
            await clone.close()
    finally:
        await src.close()


@pytest.mark.asyncio
async def test_an_empty_override_drops_the_declared_instances():
    """An explicit `{}` says "no declarations, use ambient", which a
    truthiness fallback read as "none supplied"."""
    register_secrets("aws-sm", AccountConfig, fetch_account)
    src = Workspace(
        {"/": RAMResource()},
        mode=MountMode.WRITE,
        secrets={
            "aws-sm": {
                "source": "aws-sm",
                "config": {
                    "account": "declared"
                },
            }
        },
        env={"TOKEN": {
            "from": "aws-sm",
            "ref": "r",
            "key": "credential"
        }})
    try:
        clone = await clone_workspace_with_override(src, {"secrets": {}})
        try:
            result = await clone.execute('echo "$TOKEN"')
            assert (await result.stdout_str()) == "default:r\n"
        finally:
            await clone.close()
    finally:
        await src.close()


@pytest.mark.asyncio
async def test_an_override_mount_reads_a_pointer():
    """An override mount is built before the clone exists, so its
    credential is fetched against the declarations the clone will run
    with -- unresolved, the pointer reached `SlackConfig` as a
    mapping and construction failed."""
    register_secrets("acct-mount", AccountConfig, fetch_account)
    src = Workspace(
        {
            "/": RAMResource(),
            "/slack": SlackResource(config=SlackConfig(token="xoxb-src")),
        },
        mode=MountMode.WRITE)
    try:
        clone = await clone_workspace_with_override(
            src, {
                "secrets": {
                    "prod": {
                        "source": "acct-mount",
                        "config": {
                            "account": "live"
                        },
                    }
                },
                "mounts": {
                    "/slack": {
                        "resource": "slack",
                        "config": {
                            "token": {
                                "from": "prod",
                                "ref": "bot",
                                "key": "credential"
                            }
                        },
                    }
                },
            })
        try:
            mount = clone._registry.mount_for_prefix("/slack")
            token = mount.resource.config.token
            assert token.get_secret_value() == "live:bot"
        finally:
            await clone.close()
    finally:
        await src.close()


def broken_bootstrap(source: str) -> dict[str, dict]:
    """A declaration the clone cannot build: its own config points at a
    dotenv file that is not there."""
    return {
        "prod": {
            "source": source,
            "config": {
                "account": {
                    "from": "dotenv",
                    "ref": "/no/such/file",
                    "key": "ACCOUNT"
                }
            },
        }
    }


@pytest.mark.asyncio
async def test_a_clone_with_no_override_pointer_builds_no_source():
    """The declarations travel with the clone as declarations, the way
    they did into the source workspace, and are built by the first line
    that fills a managed variable. Building them here would read a
    bootstrap file on behalf of an override that named no pointer."""
    register_secrets("acct-lazy", AccountConfig, fetch_account)
    src = Workspace({"/": RAMResource()},
                    mode=MountMode.WRITE,
                    secrets=broken_bootstrap("acct-lazy"))
    try:
        clone = await clone_workspace_with_override(src, None)
        try:
            assert set(clone.declared_sources) == {"prod"}
        finally:
            await clone.close()
        # An override that swaps a mount without naming a pointer is
        # the same case.
        clone = await clone_workspace_with_override(
            src, {"mounts": {
                "/": {
                    "resource": "ram"
                }
            }})
        await clone.close()
    finally:
        await src.close()


@pytest.mark.asyncio
async def test_an_override_pointer_still_builds_the_declared_sources():
    register_secrets("acct-wanted", AccountConfig, fetch_account)
    src = Workspace({"/": RAMResource()},
                    mode=MountMode.WRITE,
                    secrets=broken_bootstrap("acct-wanted"))
    try:
        with pytest.raises(SecretsError, match="secrets.prod.config.account"):
            await clone_workspace_with_override(
                src, {
                    "mounts": {
                        "/slack": {
                            "resource": "slack",
                            "config": {
                                "token": {
                                    "from": "prod",
                                    "ref": "bot",
                                    "key": "credential"
                                }
                            },
                        }
                    }
                })
    finally:
        await src.close()
