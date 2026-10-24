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

import inspect
from collections.abc import Callable, Iterator
from contextlib import ExitStack, contextmanager
from types import ModuleType
from typing import Any, NamedTuple
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.accessor.google_api import GoogleApiAccessor
from mirage.core.google.client import TokenManager
from mirage.core.google.config import GoogleConfig

ApiCall = Callable[..., Any]


def offline_token_manager() -> TokenManager:
    """A token manager signing with a fixed token, which never refreshes."""
    return TokenManager(GoogleConfig(access_token="t"))


class StubApi:
    """A Google service client that answers only the calls a test armed;
    any other call fails the test."""

    service = "Google"

    def __init__(self, **calls: ApiCall) -> None:
        """Args:
        **calls (ApiCall): each armed call, by its client method name.
        """
        self._calls = calls

    def __getattr__(self, name: str) -> ApiCall:
        if name.startswith("__"):
            raise AttributeError(name)
        if name not in self._calls:
            raise AssertionError(
                f"the test reached {self.service}.{name} without arming it"
            )
        return self._calls[name]


def install_api(monkeypatch: pytest.MonkeyPatch, **apis: Any) -> None:
    """Serve each client in ``apis`` from every ``GoogleApiAccessor`` for
    the test.

    Args:
        monkeypatch (pytest.MonkeyPatch): the test's monkeypatch.
        **apis (Any): each client, by its accessor property (``drive``,
            ``gmail``, ...).
    """
    for service, api in apis.items():
        monkeypatch.setattr(GoogleApiAccessor, service, _serving(api))


@contextmanager
def serve(**apis: Any) -> Iterator[None]:
    """Serve each client in ``apis`` from every ``GoogleApiAccessor`` for
    the block.

    Args:
        **apis (Any): each client, by its accessor property (``drive``,
            ``gmail``, ...).
    """
    with ExitStack() as stack:
        for service, api in apis.items():
            stack.enter_context(
                patch.object(GoogleApiAccessor, service, _serving(api))
            )
        yield


def _serving(api: Any) -> property:
    """A property answering ``api`` whatever the accessor.

    Args:
        api (Any): the client served.
    """
    return property(lambda _accessor: api)


def protocol_calls(protocol: type) -> list[str]:
    """The calls a client protocol names, sorted.

    Args:
        protocol (type): a ``Protocol`` such as ``DriveApi``.
    """
    return sorted(
        name
        for name, value in vars(protocol).items()
        if not name.startswith("_") and inspect.isfunction(value)
    )


def _parameters(call: Callable[..., Any]) -> list[tuple[str, Any, Any]]:
    return [
        (p.name, p.kind, p.default)
        for p in inspect.signature(call).parameters.values()
    ]


def parameter_drift(
    protocol: type, implementation: type
) -> dict[str, list[tuple[str, Any, Any]]]:
    """Each protocol call ``implementation`` defines with other
    parameters than the protocol's, empty when none drifts.

    Args:
        protocol (type): the client protocol.
        implementation (type): a live client or a fake.
    """
    return {
        name: _parameters(vars(implementation)[name])
        for name in protocol_calls(protocol)
        if name in vars(implementation)
        and _parameters(vars(implementation)[name])
        != _parameters(vars(protocol)[name])
    }


class Delegation(NamedTuple):
    """One client call and the wire call it must make:
    ``call(*args, **kwargs)`` sends
    ``wire(token_manager, *sent, **sent_kwargs)``."""

    call: str
    args: tuple[Any, ...]
    sent: tuple[Any, ...]
    sent_kwargs: dict[str, Any] = {}
    wire: str = ""
    kwargs: dict[str, Any] = {}


async def sends(
    client: type, module: ModuleType, case: Delegation
) -> tuple[Any, Any]:
    """Make ``case.call`` on a ``client`` with the wire function in
    ``module`` faked, check the wire call it made, and give back what it
    answered and what the fake answered.

    Args:
        client (type): the live client class, built from a token manager.
        module (ModuleType): the module holding the wire function.
        case (Delegation): the call, and the wire function's name when it
            is not the call's own.
    """
    manager = MagicMock()
    streaming = case.call.endswith("_stream")
    answer = object()
    fake = (MagicMock if streaming else AsyncMock)(return_value=answer)
    with patch.object(module, case.wire or case.call, fake):
        got = getattr(client(manager), case.call)(*case.args, **case.kwargs)
        if not streaming:
            got = await got
    fake.assert_called_once_with(manager, *case.sent, **case.sent_kwargs)
    return got, answer
