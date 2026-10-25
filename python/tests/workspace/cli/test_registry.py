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

import pytest
from pydantic import BaseModel, Field

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.commands.cli.builtin.discord import DISCORD
from mirage.commands.cli.builtin.gws import GWS
from mirage.commands.cli.builtin.slack import SLACK
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import CommandSpec
from mirage.io import IOResult
from mirage.utils.clock import ManualClock
from mirage.workspace.cli.registry import CLIRegistry


class TokenConfig(BaseModel):
    token: str


async def noop(config, paths, *texts, **flags):
    return None, IOResult()


class ClosingAccessor(Accessor):
    """Records its close, and fails it for the token ``bad``."""

    def __init__(self, config: TokenConfig) -> None:
        self.config = config
        self.closed = False
        self.closes = 0

    async def close(self) -> None:
        self.closed = True
        self.closes += 1
        if self.config.token == "bad":
            raise RuntimeError("logout failed")


def tree(config_model=None, accessor=NOOPAccessor) -> CLI:
    return CLI(
        spec=CommandSpec(name="prog", subcommands=(CommandSpec(name="run"),)),
        handlers={"run": CLIHandler(fn=noop)},
        config_model=config_model,
        accessor=accessor,
    )


def test_install_and_get_and_items():
    reg = CLIRegistry()
    install = reg.install("prog", tree())
    assert reg.get("prog") is install
    assert reg.get("other") is None
    assert reg.items() == {"prog": install}


def test_two_installs_of_one_spec_hold_their_own_configs():
    reg = CLIRegistry()
    spec = tree(TokenConfig)
    eng = reg.install("prog", spec, {"token": "eng"})
    sup = reg.install("prog-sup", spec, {"token": "sup"})
    assert eng.config is not None and eng.config.token == "eng"
    assert sup.config is not None and sup.config.token == "sup"


def test_name_must_be_a_single_word():
    reg = CLIRegistry()
    with pytest.raises(ValueError, match="single word"):
        reg.install("two words", tree())
    with pytest.raises(ValueError, match="single word"):
        reg.install("", tree())


def test_duplicate_name_is_refused():
    reg = CLIRegistry()
    reg.install("prog", tree())
    with pytest.raises(ValueError, match="already installed"):
        reg.install("prog", tree())


def test_shell_builtin_collision_is_refused():
    reg = CLIRegistry()
    with pytest.raises(ValueError, match="shell builtin"):
        reg.install("cd", tree())
    with pytest.raises(ValueError, match="shell builtin"):
        reg.install("kill", tree())


def test_shell_keyword_is_refused():
    # The parser consumes a reserved word, so the install would never be
    # reachable from a line.
    reg = CLIRegistry()
    with pytest.raises(ValueError, match="shell keyword"):
        reg.install("if", tree())
    with pytest.raises(ValueError, match="shell keyword"):
        reg.install("select", tree())


def test_general_command_collision_is_refused():
    reg = CLIRegistry()
    with pytest.raises(ValueError, match="general command"):
        reg.install("grep", tree())
    with pytest.raises(ValueError, match="general command"):
        reg.install("ln", tree())


def test_config_validates_through_the_model_fail_loud():
    reg = CLIRegistry()
    with pytest.raises(ValueError, match="CLI 'prog': token: missing"):
        reg.install("prog", tree(TokenConfig), {})
    with pytest.raises(ValueError, match="unknown config keys: extra"):
        reg.install("prog", tree(TokenConfig), {"token": "x", "extra": 1})


class PortConfig(BaseModel):
    host: str
    port: int


def test_a_refused_config_value_is_not_in_the_error():
    """An account CLI's config is where a fetched credential lands, and
    the create route answers `str(e)` as its 400 detail. Pydantic puts
    the value it refused in `input_value`, so an unparseable secret
    came back to a caller whose only way to name it was a pointer."""
    secret = "sk-live-notanumber"
    reg = CLIRegistry()
    with pytest.raises(ValueError) as caught:
        reg.install("prog", tree(PortConfig), {"host": "h", "port": secret})
    message = str(caught.value)
    assert secret not in message
    assert message == "CLI 'prog': port: int_parsing"
    # The chain would carry the value into any logged traceback.
    assert caught.value.__cause__ is None


def test_an_instance_of_the_model_installs_as_it_is():
    reg = CLIRegistry()
    config = TokenConfig(token="eng")
    assert reg.install("prog", tree(TokenConfig), config).config is config


class ScopedTokenConfig(TokenConfig):
    scope: str = "all"


def test_an_instance_of_a_subclass_is_narrowed_to_the_model():
    reg = CLIRegistry()
    config = ScopedTokenConfig(token="eng")
    stored = reg.install("prog", tree(TokenConfig), config).config
    assert type(stored) is TokenConfig
    assert stored == TokenConfig(token="eng")


class AliasedTokenConfig(BaseModel):
    token: str = Field(alias="api_token")


class ScopedAliasedTokenConfig(AliasedTokenConfig):
    scope: str = "all"


def test_a_subclass_instance_of_an_aliased_model_installs():
    reg = CLIRegistry()
    config = ScopedAliasedTokenConfig(api_token="eng")
    stored = reg.install("prog", tree(AliasedTokenConfig), config).config
    assert type(stored) is AliasedTokenConfig
    assert stored.token == "eng"


@pytest.mark.parametrize(
    "config",
    [
        ScopedTokenConfig(token="eng", scope="read"),
        ScopedTokenConfig(token="eng").model_dump(),
    ],
)
def test_a_subclass_field_the_caller_set_is_refused(config):
    reg = CLIRegistry()
    with pytest.raises(ValueError, match="unknown config keys: scope"):
        reg.install("prog", tree(TokenConfig), config)


@pytest.mark.parametrize(
    "config,message",
    [
        (
            PortConfig(host="h", port=1),
            "CLI 'prog': config must be a mapping or a TokenConfig, got PortConfig",
        ),
        (
            "token",
            "CLI 'prog': config must be a mapping or a TokenConfig, got str",
        ),
        (
            ["token"],
            "CLI 'prog': config must be a mapping or a TokenConfig, got list",
        ),
    ],
)
def test_a_config_that_is_neither_is_refused_by_type(config, message):
    reg = CLIRegistry()
    with pytest.raises(ValueError) as caught:
        reg.install("prog", tree(TokenConfig), config)
    assert str(caught.value) == message


def test_a_model_instance_for_a_spec_without_a_model_is_refused():
    reg = CLIRegistry()
    with pytest.raises(
        ValueError, match="config must be a mapping, got TokenConfig"
    ):
        reg.install("prog", tree(), TokenConfig(token="x"))


def test_config_without_model_is_refused():
    reg = CLIRegistry()
    with pytest.raises(ValueError, match="declares no config_model"):
        reg.install("prog", tree(), {"token": "x"})


def test_no_config_no_model_installs_with_none():
    reg = CLIRegistry()
    assert reg.install("prog", tree()).config is None


@pytest.mark.asyncio
async def test_uninstall_removes_and_unknown_raises():
    reg = CLIRegistry()
    reg.install("prog", tree())
    await reg.uninstall("prog")
    assert reg.get("prog") is None
    with pytest.raises(KeyError, match="not installed"):
        await reg.uninstall("prog")


@pytest.mark.asyncio
async def test_close_closes_every_accessor_past_a_failed_one():
    reg = CLIRegistry()
    spec = tree(TokenConfig, ClosingAccessor)
    failing = reg.install("one", spec, {"token": "bad"})
    other = reg.install("two", spec, {"token": "ok"})
    with pytest.raises(RuntimeError, match="logout failed"):
        await reg.close()
    assert failing.accessor.closed
    assert other.accessor.closed
    assert reg.names() == frozenset()


@pytest.mark.asyncio
async def test_close_lets_a_running_line_finish_before_its_accessor_goes():
    reg = CLIRegistry()
    install = reg.install(
        "prog", tree(TokenConfig, ClosingAccessor), {"token": "ok"}
    )
    release = install.activity.acquire()
    closing = asyncio.create_task(reg.close())
    await asyncio.sleep(0)
    assert not install.accessor.closed
    release()
    await asyncio.wait_for(closing, 1)
    assert install.accessor.closed


@pytest.mark.asyncio
async def test_close_does_not_wait_out_a_line_that_never_ends():
    reg = CLIRegistry()
    install = reg.install(
        "prog", tree(TokenConfig, ClosingAccessor), {"token": "ok"}
    )
    install.activity.acquire()
    await asyncio.wait_for(reg.close(), 5)
    assert install.accessor.closed


@pytest.mark.asyncio
@pytest.mark.parametrize("token", ["ok", "bad"])
async def test_close_gives_a_pending_removal_the_shutdown_grace(token):
    reg = CLIRegistry()
    install = reg.install(
        "prog", tree(TokenConfig, ClosingAccessor), {"token": token}
    )
    release = install.activity.acquire()
    removing = asyncio.create_task(reg.uninstall("prog"))
    await asyncio.sleep(0)
    closing = asyncio.create_task(reg.close())
    try:
        done, _ = await asyncio.wait({closing, removing}, timeout=1)
        assert done == {closing, removing}
        results = await asyncio.gather(
            closing, removing, return_exceptions=True
        )
        if token == "bad":
            assert all(isinstance(result, RuntimeError) for result in results)
        else:
            assert results == [None, None]
        assert install.accessor.closes == 1
    finally:
        release()
        await asyncio.gather(closing, removing, return_exceptions=True)


@pytest.mark.asyncio
async def test_a_cancelled_close_still_closes_and_a_retry_waits_for_it():
    reg = CLIRegistry()
    install = reg.install(
        "prog", tree(TokenConfig, ClosingAccessor), {"token": "ok"}
    )
    release = install.activity.acquire()
    closing = asyncio.create_task(reg.close())
    await asyncio.sleep(0)
    closing.cancel()
    with pytest.raises(asyncio.CancelledError):
        await closing
    assert not install.accessor.closed
    retry = asyncio.create_task(reg.close())
    await asyncio.sleep(0)
    assert not retry.done()
    release()
    await asyncio.wait_for(retry, 1)
    assert install.accessor.closed


@pytest.mark.parametrize("name,spec", [("slack", SLACK), ("discord", DISCORD)])
def test_account_clis_refuse_a_mount_time_scope(name, spec):
    with pytest.raises(
        ValueError, match="unknown config keys: end_time, start_time"
    ):
        CLIRegistry().install(
            name,
            spec,
            {
                "token": "x",
                "start_time": "2026-06-01T00:00:00Z",
                "end_time": "2026-06-02T00:00:00Z",
            },
        )


def test_releasing_clocks_lets_every_install_go():
    registry = CLIRegistry(clock=ManualClock())
    install = registry.install(
        "gws", GWS, {"client_id": "c", "refresh_token": "r"}
    )
    with pytest.raises(ValueError, match="another clock"):
        install.accessor.bind_clock(ManualClock(), "later")
    registry.release_clocks()
    later = ManualClock()
    install.accessor.bind_clock(later, "later")
    assert install.accessor.token_manager.clock is later
