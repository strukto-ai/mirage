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
import errno
import json
import os
import socket
import sys
import threading
from collections import OrderedDict
from collections.abc import Awaitable, Mapping, Sequence
from contextvars import ContextVar
from typing import Any, TypeAlias, TypeVar

from mirage._rs import Stream, StreamError
from mirage.types import JsonValue

T = TypeVar("T")

# A workspace's `network`: True for no limit, False for none at all, or
# the hosts and ranges it may reach, `{"allow": [...]}`.
NetworkSetting: TypeAlias = bool | Mapping[str, Sequence[str]]

# The audit events a connection raises, its address their second argument.
_CONNECTING = frozenset({"socket.connect", "socket.sendto"})

# How many addresses a rule's lookups let are kept for its connects.
_RESOLVED_SIZE = 4096


class NetworkRule:
    """Whether a workspace may open one connection: its ``network``
    setting, the process's ceiling and the metadata block, each a layer
    mirage-rs compiles once and every connection must clear. Mirrors the
    TS ``NetworkRule``.

    Args:
        layers (Sequence[Mapping[str, JsonValue]]): each an ``allow``
            list, a ``deny`` list, or both.
        metadata (bool): refuse the addresses clouds serve a machine its
            credentials at.

    Raises:
        ValueError: an entry is not an address, a range or a host name.
    """

    def __init__(
        self, layers: Sequence[Mapping[str, JsonValue]], metadata: bool = False
    ) -> None:
        config: dict[str, JsonValue] = {
            "layers": [dict(layer) for layer in layers],
            "metadata": metadata,
        }
        try:
            self._stream = Stream("network", json.dumps(config).encode())
        except StreamError as exc:
            raise ValueError(str(exc)) from exc
        # The audit hook asks from any thread, and a test runs with the
        # GIL released: one test goes through the stream at a time.
        self._lock = threading.Lock()
        # The addresses a lookup this rule let answered, which a connect,
        # naming only its address, may open to.
        self._resolved: OrderedDict[str, None] = OrderedDict()

    def lets(self, host: str, address: str) -> bool:
        """Whether a connection to ``address``, resolved for ``host``, opens.

        Args:
            host (str): the name it was resolved for, empty when unknown.
            address (str): the address it connects to, empty when unknown.
        """
        with self._lock:
            return self._stream.test(f"{host}\0{address}".encode())

    def resolved(self, host: str, address: str) -> bool:
        """Whether a lookup of ``host`` may answer ``address``; one that
        may lets this rule's connects open to it.

        Args:
            host (str): the name looked up.
            address (str): one address it resolved to.
        """
        if not self.lets(host, address):
            return False
        with self._lock:
            self._resolved.pop(address, None)
            self._resolved[address] = None
            while len(self._resolved) > _RESOLVED_SIZE:
                self._resolved.popitem(last=False)
        return True

    def connects(self, address: str) -> bool:
        """Whether a connection to ``address`` opens: one a lookup this
        rule let answered, or one the rule lets by its address alone.

        Args:
            address (str): the address it connects to.
        """
        with self._lock:
            if address in self._resolved:
                return True
        return self.lets("", address)


def network_layer(setting: NetworkSetting) -> dict[str, JsonValue] | None:
    """The layer a ``network`` setting adds: none for True, one that lets
    nothing for False, and its allow list for a mapping. Mirrors TS's
    ``networkLayer``.

    Args:
        setting (NetworkSetting): the setting as written.

    Raises:
        ValueError: the setting is none of the three.
    """
    if setting is True:
        return None
    if setting is False:
        return {"allow": []}
    if (
        isinstance(setting, Mapping)
        and set(setting) == {"allow"}
        and isinstance(setting["allow"], Sequence)
        and not isinstance(setting["allow"], str)
        and all(isinstance(entry, str) for entry in setting["allow"])
    ):
        return {"allow": list(setting["allow"])}
    raise ValueError(
        "network is true, false or {allow: [hosts and ranges]}, "
        f"not {setting!r}"
    )


def network_rule(
    setting: NetworkSetting = True,
    ceiling: NetworkSetting = True,
    metadata: bool = False,
) -> NetworkRule | None:
    """The rule a workspace's connections are judged by: its own setting
    and the ceiling of the server that built it, each a layer, with the
    cloud metadata addresses refused when ``metadata`` is set; None when
    nothing limits it. The first rule built starts watching the process's
    connections. Mirrors TS's ``networkRule``.

    Args:
        setting (NetworkSetting): the workspace's ``network``.
        ceiling (NetworkSetting): what its server holds every workspace to.
        metadata (bool): refuse the addresses clouds serve a machine its
            credentials at.

    Raises:
        ValueError: a setting or one of its entries is not valid.
    """
    layers = [
        layer
        for layer in (network_layer(ceiling), network_layer(setting))
        if layer is not None
    ]
    if not layers and not metadata:
        return None
    rule = NetworkRule(layers, metadata)
    watch_network()
    return rule


# The rule of the workspace a line or an op runs for, None for no limit.
_rule: ContextVar[NetworkRule | None] = ContextVar(
    "mirage_network_rule", default=None
)


async def run_with_network(rule: NetworkRule | None, call: Awaitable[T]) -> T:
    """``call`` awaited under a workspace's network rule, which every
    connection it opens must clear. Mirrors TS's ``runWithNetwork``.

    Args:
        rule (NetworkRule | None): the workspace's rule, None for none.
        call (Awaitable[T]): the line or the op.
    """
    token = _rule.set(rule)
    try:
        return await call
    finally:
        _rule.reset(token)


def network_lets(host: str, address: str) -> bool:
    """Whether the workspace a call runs for may open a connection to
    ``address``, resolved for ``host``. Mirrors TS's ``networkLets``.

    Args:
        host (str): the name it was resolved for, empty when unknown.
        address (str): the address it connects to, empty when unknown.
    """
    rule = _rule.get()
    return rule is None or rule.lets(host, address)


def network_bound() -> NetworkRule | None:
    """The rule bound to the running call, None for none, which a
    watcher reads to skip the rest. Mirrors TS's ``networkBound``."""
    return _rule.get()


_resolve = socket.getaddrinfo
_loop_resolve = asyncio.base_events.BaseEventLoop.getaddrinfo
_watching = False
_watch_lock = threading.Lock()


def _judged(
    rule: NetworkRule, host: bytes | str | None, found: list[Any]
) -> list[Any]:
    """The answers of a lookup a rule lets, each judged by the name it
    was asked for; refused when it lets none.

    Args:
        rule (NetworkRule): the rule bound to the lookup.
        host (bytes | str | None): the name looked up.
        found (list[Any]): what ``getaddrinfo`` answered.

    Raises:
        PermissionError: EACCES, the rule lets none of them.
    """
    if not host:
        return found
    name = host.decode() if isinstance(host, bytes) else host
    let = [info for info in found if rule.resolved(name, str(info[4][0]))]
    if found and not let:
        raise PermissionError(errno.EACCES, os.strerror(errno.EACCES))
    return let


def _getaddrinfo(
    host: bytes | str | None,
    port: bytes | str | int | None,
    *args: Any,
    **kwargs: Any,
) -> list[Any]:
    found = _resolve(host, port, *args, **kwargs)
    rule = _rule.get()
    return found if rule is None else _judged(rule, host, found)


async def _loop_getaddrinfo(
    loop: asyncio.BaseEventLoop,
    host: bytes | str | None,
    port: bytes | str | int | None,
    *args: Any,
    **kwargs: Any,
) -> list[Any]:
    found = await _loop_resolve(loop, host, port, *args, **kwargs)
    rule = _rule.get()
    return found if rule is None else _judged(rule, host, found)


def _connecting(event: str, args: tuple[Any, ...]) -> None:
    if event not in _CONNECTING:
        return
    rule = _rule.get()
    if rule is None:
        return
    target = args[1]
    if not isinstance(target, tuple) or not isinstance(target[0], str):
        return
    if not rule.connects(target[0]):
        raise PermissionError(errno.EACCES, os.strerror(errno.EACCES))


def watch_network() -> None:
    """Start judging every connection the process opens, once: each
    lookup by the name it was asked for, on a thread or on an event
    loop, and each connect by its address. A hook cannot be removed, and
    one with no rule bound returns at once. Mirrors TS's
    ``watchNetwork``.
    """
    global _watching
    with _watch_lock:
        if _watching:
            return
        _watching = True
        socket.getaddrinfo = _getaddrinfo
        setattr(
            asyncio.base_events.BaseEventLoop, "getaddrinfo", _loop_getaddrinfo
        )
        sys.addaudithook(_connecting)
