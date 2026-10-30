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
# the hosts and ranges it may and may not reach,
# `{"allowed_domains": [...], "denied_domains": [...]}`.
NetworkSetting: TypeAlias = bool | Mapping[str, Sequence[str]]

# Each list a `network` mapping takes, and the rule layer it fills.
_LISTS = {"allowed_domains": "allow", "denied_domains": "deny"}

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
        # What it was built from, which a narrower rule builds on.
        self.layers = tuple(dict(layer) for layer in layers)
        self.metadata = metadata
        # The audit hook asks from any thread, and a test runs with the
        # GIL released: one test goes through the stream at a time.
        self._lock = threading.Lock()
        # The name each address a lookup this rule let answered was asked
        # for, which a connect, naming only its address, is judged by.
        self._resolved: OrderedDict[str, str] = OrderedDict()

    def lets(self, host: str, address: str, port: int | None = None) -> bool:
        """Whether a connection to ``address``, resolved for ``host``, opens.

        Args:
            host (str): the name it was resolved for, empty when unknown.
            address (str): the address it connects to, empty when unknown.
            port (int | None): the port it connects to, None when unknown.
        """
        subject = f"{host}\0{address}\0{'' if port is None else port}"
        with self._lock:
            return self._stream.test(subject.encode())

    def resolved(
        self, host: str, address: str, port: int | None = None
    ) -> bool:
        """Whether a lookup of ``host`` may answer ``address``; the name
        it was asked for judges this rule's connects to it.

        Args:
            host (str): the name looked up.
            address (str): one address it resolved to.
            port (int | None): the port it was looked up for, None when
                unknown.
        """
        if not self.lets(host, address, port):
            return False
        with self._lock:
            self._resolved.pop(address, None)
            self._resolved[address] = host
            while len(self._resolved) > _RESOLVED_SIZE:
                self._resolved.popitem(last=False)
        return True

    def connects(self, address: str, port: int | None = None) -> bool:
        """Whether a connection to ``address`` opens, judged by the name a
        lookup this rule let answered it for, else by its address alone.

        Args:
            address (str): the address it connects to.
            port (int | None): the port it connects to.
        """
        with self._lock:
            host = self._resolved.get(address, "")
        return self.lets(host, address, port)


def network_layer(setting: NetworkSetting) -> dict[str, JsonValue] | None:
    """The layer a ``network`` setting adds: none for True, one that lets
    nothing for False, and its allowed and denied lists for a mapping.
    Mirrors TS's ``networkLayer``.

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
        and setting
        and set(setting) <= set(_LISTS)
        and all(
            isinstance(entries, Sequence)
            and not isinstance(entries, str)
            and all(isinstance(entry, str) for entry in entries)
            for entries in setting.values()
        )
    ):
        return {_LISTS[key]: list(entries) for key, entries in setting.items()}
    raise ValueError(
        "network is true, false or {allowed_domains: [...], "
        "denied_domains: [...]}, "
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


def network_lets(host: str, address: str, port: int | None = None) -> bool:
    """Whether the workspace a call runs for may open a connection to
    ``address``, resolved for ``host``. Mirrors TS's ``networkLets``.

    Args:
        host (str): the name it was resolved for, empty when unknown.
        address (str): the address it connects to, empty when unknown.
        port (int | None): the port it connects to, None when unknown.
    """
    rule = _rule.get()
    return rule is None or rule.lets(host, address, port)


def network_bound() -> NetworkRule | None:
    """The rule bound to the running call, None for none, which a
    watcher reads to skip the rest. Mirrors TS's ``networkBound``."""
    return _rule.get()


_resolve = socket.getaddrinfo
_loop_resolve = asyncio.base_events.BaseEventLoop.getaddrinfo
_watching = False
_watch_lock = threading.Lock()


def _judged(
    rule: NetworkRule,
    host: bytes | str | None,
    port: bytes | str | int | None,
    found: list[Any],
) -> list[Any]:
    """The answers of a lookup a rule lets, each judged by the name it
    was asked for; refused when it lets none.

    Args:
        rule (NetworkRule): the rule bound to the lookup.
        host (bytes | str | None): the name looked up.
        port (bytes | str | int | None): the port it was looked up for.
        found (list[Any]): what ``getaddrinfo`` answered.

    Raises:
        PermissionError: EACCES, the rule lets none of them.
    """
    if not host:
        return found
    name = host.decode() if isinstance(host, bytes) else host
    # A service name or none at all leaves the port to the connect.
    text = port.decode() if isinstance(port, bytes) else port
    wanted = (
        text
        if isinstance(text, int)
        else int(text)
        if text is not None and text.isdigit()
        else None
    )
    let = [
        info for info in found if rule.resolved(name, str(info[4][0]), wanted)
    ]
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
    return found if rule is None else _judged(rule, host, port, found)


async def _loop_getaddrinfo(
    loop: asyncio.BaseEventLoop,
    host: bytes | str | None,
    port: bytes | str | int | None,
    *args: Any,
    **kwargs: Any,
) -> list[Any]:
    found = await _loop_resolve(loop, host, port, *args, **kwargs)
    rule = _rule.get()
    return found if rule is None else _judged(rule, host, port, found)


def _connecting(event: str, args: tuple[Any, ...]) -> None:
    if event not in _CONNECTING:
        return
    rule = _rule.get()
    if rule is None:
        return
    target = args[1]
    if not isinstance(target, tuple) or not isinstance(target[0], str):
        return
    port = (
        target[1] if len(target) > 1 and isinstance(target[1], int) else None
    )
    if not rule.connects(target[0], port):
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
