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
import re
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
# the hosts and ranges it may and may not reach and where a connection
# goes instead,
# `{"allowed_domains": [...], "denied_domains": [...], "routes": {...}}`.
NetworkSetting: TypeAlias = (
    bool | Mapping[str, Sequence[str] | Mapping[str, str]]
)

# Each list a `network` mapping takes, and the rule layer it fills.
_LISTS = {"allowed_domains": "allow", "denied_domains": "deny"}

_SHAPE = "{allowed_domains: [...], denied_domains: [...], routes: {...}}"

# A route's end: a bracketed address or a name, and a port.
_ENDPOINT = re.compile(r"(?:\[([^\]]+)\]|([^:\s/\[\]]+)):(\d+)")

# The audit events a connection raises, its address their second argument.
_CONNECTING = frozenset({"socket.connect", "socket.sendto"})

# How many addresses a rule's lookups let are kept for its connects.
_RESOLVED_SIZE = 4096


def _endpoint(text: str) -> tuple[str, int]:
    """A route's end, ``host:port`` (an IPv6 address bracketed), as the
    host and the port a connection names them: the host in lower case,
    without its brackets or a trailing dot.

    Args:
        text (str): the end as written.

    Raises:
        ValueError: it is not ``host:port``.
    """
    match = _ENDPOINT.fullmatch(text)
    port = int(match.group(3)) if match is not None else 0
    if match is None or not 0 < port < 65536:
        raise ValueError(f"network: route {json.dumps(text)} is not host:port")
    host = (match.group(1) or match.group(2)).lower()
    return host.removesuffix("."), port


class NetworkRule:
    """Whether a workspace may open one connection: its ``network``
    setting, the process's ceiling and the metadata block, each a layer
    mirage-rs compiles once and every connection must clear, and where a
    connection goes instead. Mirrors the TS ``NetworkRule``.

    Args:
        layers (Sequence[Mapping[str, JsonValue]]): each an ``allow``
            list, a ``deny`` list, or both.
        metadata (bool): refuse the addresses clouds serve a machine its
            credentials at.
        routes (Mapping[str, str] | None): where a connection to
            ``host:port`` goes instead, judged there.

    Raises:
        ValueError: an entry is not an address, a range or a host name,
            or a route is not ``host:port`` or goes to a routed end.
    """

    def __init__(
        self,
        layers: Sequence[Mapping[str, JsonValue]],
        metadata: bool = False,
        routes: Mapping[str, str] | None = None,
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
        self.routes = dict(routes or {})
        self._targets: dict[tuple[str, int], tuple[str, int]] = {}
        sources: dict[tuple[str, int], str] = {}
        for source, target in self.routes.items():
            end = _endpoint(source)
            if end in sources:
                raise ValueError(
                    f"network: routes {sources[end]} and {source} "
                    "name the same end"
                )
            sources[end] = source
            self._targets[end] = _endpoint(target)
        for source, target in self.routes.items():
            if _endpoint(target) in self._targets:
                raise ValueError(
                    f"network: route {source} goes to {target}, "
                    "which is routed too"
                )
        # The audit hook asks from any thread, and a test runs with the
        # GIL released: one test goes through the stream at a time.
        self._lock = threading.Lock()
        # Each address a lookup this rule let answered, with the port the
        # lookup was for (None when it named none) and the name it was
        # asked for, which a connect, naming only its address, is judged
        # by. Keyed by the port too, so two names sharing an address keep
        # their own ports.
        self._resolved: OrderedDict[tuple[str, int | None], str] = (
            OrderedDict()
        )

    def route(self, host: str, port: int) -> tuple[str, int] | None:
        """Where a connection to ``host`` on ``port`` goes instead: the
        host and the port its route names, None for none.

        Args:
            host (str): the name or the address it connects to.
            port (int): the port it connects to.
        """
        name = host.lower()
        if name.startswith("[") and name.endswith("]"):
            name = name[1:-1]
        return self._targets.get((name.removesuffix("."), port))

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
        """Whether a lookup of ``host`` may answer ``address``; one that
        may lets this rule's connects to it at the port it was for, and
        the name it was asked for judges the rest.

        Args:
            host (str): the name looked up.
            address (str): one address it resolved to.
            port (int | None): the port it was looked up for, None when
                unknown.
        """
        if not self.lets(host, address, port):
            return False
        with self._lock:
            self._resolved.pop((address, port), None)
            self._resolved[(address, port)] = host
            while len(self._resolved) > _RESOLVED_SIZE:
                self._resolved.popitem(last=False)
        return True

    def connects(self, address: str, port: int | None = None) -> bool:
        """Whether a connection to ``address`` opens: one a lookup this
        rule let answered for this port, else one judged by the name a
        lookup that named no port answered it for, else by its address
        alone.

        Args:
            address (str): the address it connects to.
            port (int | None): the port it connects to.
        """
        with self._lock:
            if (address, port) in self._resolved:
                return True
            host = self._resolved.get((address, None), "")
        return self.lets(host, address, port)


def _field(key: str, value: Any) -> bool:
    if key == "routes":
        return isinstance(value, Mapping) and all(
            isinstance(target, str) for target in value.values()
        )
    return (
        key in _LISTS
        and isinstance(value, Sequence)
        and not isinstance(value, str)
        and all(isinstance(entry, str) for entry in value)
    )


def network_layer(setting: NetworkSetting) -> dict[str, JsonValue] | None:
    """The layer a ``network`` setting adds: none for True or routes
    alone, one that lets nothing for False, and its allowed and denied
    lists for a mapping. Mirrors TS's ``networkLayer``.

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
        and all(_field(key, value) for key, value in setting.items())
    ):
        layer: dict[str, JsonValue] = {
            _LISTS[key]: list(entries)
            for key, entries in setting.items()
            if key in _LISTS
        }
        return layer or None
    raise ValueError(f"network is true, false or {_SHAPE}, not {setting!r}")


def network_routes(setting: NetworkSetting) -> dict[str, str]:
    """The routes a ``network`` setting names, ``{"host:port":
    "host:port"}``; none for True or False. Mirrors TS's
    ``networkRoutes``.

    Args:
        setting (NetworkSetting): the setting as written.
    """
    if isinstance(setting, bool):
        return {}
    routes = setting.get("routes")
    return dict(routes) if isinstance(routes, Mapping) else {}


def merge_routes(
    base: Mapping[str, str], over: Mapping[str, str]
) -> dict[str, str]:
    """``base``'s routes with ``over``'s in place of any naming the same
    end, as a session's profile routes over its workspace's. Mirrors TS's
    ``mergeRoutes``.

    Args:
        base (Mapping[str, str]): the routes routed over.
        over (Mapping[str, str]): the routes that win.
    """
    named = {_endpoint(source) for source in over}
    kept = {
        source: target
        for source, target in base.items()
        if _endpoint(source) not in named
    }
    return {**kept, **over}


def network_rule(
    setting: NetworkSetting = True, metadata: bool = False
) -> NetworkRule | None:
    """The rule a workspace's connections are judged by: its ``network``,
    with the cloud metadata addresses refused when ``metadata`` is set;
    None when nothing limits or routes it. The first rule built starts watching the
    process's connections. Mirrors TS's ``networkRule``.

    Args:
        setting (NetworkSetting): the workspace's ``network``.
        metadata (bool): refuse the addresses clouds serve a machine its
            credentials at.

    Raises:
        ValueError: the setting or one of its entries is not valid.
    """
    layer = network_layer(setting)
    layers = [] if layer is None else [layer]
    routes = network_routes(setting)
    if not layers and not metadata and not routes:
        return None
    rule = NetworkRule(layers, metadata, routes)
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


def network_route(host: str, port: int) -> tuple[str, int] | None:
    """Where the workspace a call runs for sends a connection to ``host``
    on ``port`` instead, None for nowhere else. Mirrors TS's
    ``networkRoute``.

    Args:
        host (str): the name or the address it connects to.
        port (int): the port it connects to.
    """
    rule = _rule.get()
    return None if rule is None else rule.route(host, port)


def network_bound() -> NetworkRule | None:
    """The rule bound to the running call, None for none, which a
    watcher reads to skip the rest. Mirrors TS's ``networkBound``."""
    return _rule.get()


_resolve = socket.getaddrinfo
_loop_resolve = asyncio.base_events.BaseEventLoop.getaddrinfo
_watching = False
_watch_lock = threading.Lock()
# The lookups the running call made, newest last: each name, the port it
# was looked up for (None when it named none) and the addresses it
# answered, which a connect, naming only its address, reports its host
# and its other addresses by. Kept per call, so no other workspace's
# lookup lends a connection its name.
_lookups: ContextVar[tuple[tuple[str, int | None, tuple[str, ...]], ...]] = (
    ContextVar("mirage_lookups", default=())
)
# How many of a call's lookups are kept.
_LOOKUPS_KEPT = 16
# The running call's routed lookups not yet connected, newest last: the
# rule that routed each, the addresses it answered, the port the program
# asked for and the port its route names. The first connect to each of its
# addresses on the port asked is sent on to the route's port, and that
# address leaves the lookup, as a client falling back tries each once.
_hops: ContextVar[
    tuple[tuple[NetworkRule, tuple[str, ...], int, int], ...]
] = ContextVar("mirage_hops", default=())
_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex
# The listeners the gateway relays from, which a connect may always reach:
# the gateway judges what is behind them.
_relays: set[tuple[str, int]] = set()


def named(address: str, port: int | None = None) -> str:
    """The name the running call's lookup was asked for when it answered
    ``address``, for this port or for none; empty when none did.

    Args:
        address (str): the address a connection reaches.
        port (int | None): the port it reaches.
    """
    for host, wanted, addresses in reversed(_lookups.get()):
        if address in addresses and wanted in (port, None):
            return host
    return ""


def answers(host: str, port: int | None = None) -> tuple[str, ...]:
    """The addresses the running call's last lookup of ``host`` answered,
    for this port or for none, in the order it gave them.

    Args:
        host (str): the name looked up.
        port (int | None): the port it was looked up for.
    """
    for name, wanted, addresses in reversed(_lookups.get()):
        if name == host and wanted in (port, None):
            return addresses
    return ()


def routed(sock: socket.socket, address: Any) -> Any:
    """Where ``sock`` connects instead of ``address``: on to the port a
    route names when a routed lookup of the running call, under the bound
    rule and not yet connected, answered the address for the port asked,
    else where a route of the bound rule
    sends the address and port, its end looked up for the socket's
    family; ``address`` itself when none does.

    Args:
        sock (socket.socket): the connecting socket.
        address (Any): where the program connects it.
    """
    rule = _rule.get()
    if (
        rule is None
        or not isinstance(address, tuple)
        or len(address) < 2
        or not isinstance(address[0], str)
        or not isinstance(address[1], int)
    ):
        return address
    host, port = address[0], address[1]
    hops = _hops.get()
    for at in range(len(hops) - 1, -1, -1):
        owner, answered, asked, to = hops[at]
        if owner is rule and host in answered and asked == port:
            left = tuple(other for other in answered if other != host)
            rest = ((owner, left, asked, to),) if left else ()
            _hops.set(hops[:at] + rest + hops[at + 1 :])
            return (host, to, *address[2:])
    target = rule.route(host, port)
    if target is None:
        return address
    found = socket.getaddrinfo(target[0], target[1], sock.family, sock.type)
    return found[0][4] if found else address


def relay_at(host: str, port: int) -> None:
    """Let connections to a gateway listener through the connect hook,
    which judges each one behind it.

    Args:
        host (str): the listener's address.
        port (int): its port.
    """
    _relays.add((host, port))


def _remember(
    host: bytes | str | None, port: int | None, found: list[Any]
) -> None:
    if not host:
        return
    name = host.decode() if isinstance(host, bytes) else host
    addresses = tuple(dict.fromkeys(str(info[4][0]) for info in found))
    kept = _lookups.get()[1 - _LOOKUPS_KEPT :]
    _lookups.set((*kept, (name, port, addresses)))


def _port_of(port: bytes | str | int | None) -> int | None:
    text = port.decode() if isinstance(port, bytes) else port
    if isinstance(text, int):
        return text
    return int(text) if text is not None and text.isdigit() else None


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
    wanted = _port_of(port)
    let = [
        info for info in found if rule.resolved(name, str(info[4][0]), wanted)
    ]
    if found and not let:
        raise PermissionError(errno.EACCES, os.strerror(errno.EACCES))
    return let


def _routed(
    rule: NetworkRule | None,
    host: bytes | str | None,
    port: bytes | str | int | None,
) -> tuple[bytes | str | None, bytes | str | int | None, int | None]:
    """The name and the port a lookup asks for: where the rule routes
    ``host`` on ``port``, else the two as given; and the port asked when
    routed, None when not.

    Args:
        rule (NetworkRule | None): the rule bound to the lookup.
        host (bytes | str | None): the name looked up.
        port (bytes | str | int | None): the port it was looked up for.
    """
    wanted = _port_of(port)
    if rule is None or not host or wanted is None:
        return host, port, None
    name = host.decode() if isinstance(host, bytes) else host
    target = rule.route(name, wanted)
    if target is None:
        return host, port, None
    return target[0], target[1], wanted


def _hop(
    rule: NetworkRule | None,
    asked: int | None,
    to: bytes | str | int | None,
    found: list[Any],
) -> None:
    if rule is None or asked is None or not isinstance(to, int) or not found:
        return
    answered = tuple(dict.fromkeys(str(info[4][0]) for info in found))
    kept = _hops.get()[1 - _LOOKUPS_KEPT :]
    _hops.set((*kept, (rule, answered, asked, to)))


def _getaddrinfo(
    host: bytes | str | None,
    port: bytes | str | int | None,
    *args: Any,
    **kwargs: Any,
) -> list[Any]:
    rule = _rule.get()
    host, port, asked = _routed(rule, host, port)
    found = _resolve(host, port, *args, **kwargs)
    let = found if rule is None else _judged(rule, host, port, found)
    _remember(host, _port_of(port), let)
    _hop(rule, asked, port, let)
    return let


async def _loop_getaddrinfo(
    loop: asyncio.BaseEventLoop,
    host: bytes | str | None,
    port: bytes | str | int | None,
    *args: Any,
    **kwargs: Any,
) -> list[Any]:
    rule = _rule.get()
    host, port, asked = _routed(rule, host, port)
    found = await _loop_resolve(loop, host, port, *args, **kwargs)
    let = found if rule is None else _judged(rule, host, port, found)
    _remember(host, _port_of(port), let)
    _hop(rule, asked, port, let)
    return let


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
    if port is not None and (target[0], port) in _relays:
        return
    if not rule.connects(target[0], port):
        raise PermissionError(errno.EACCES, os.strerror(errno.EACCES))


def _connecting_to(sock: socket.socket, address: Any) -> None:
    _connect(sock, routed(sock, address))


def _connecting_to_ex(sock: socket.socket, address: Any) -> int:
    return _connect_ex(sock, routed(sock, address))


def watch_network() -> None:
    """Start judging every connection the process opens, once: each
    lookup by the name it was asked for, or the end its route names, on
    a thread or on an event loop, and each connect by its address, sent
    on where a route names first. A hook cannot be removed, and
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
        setattr(socket.socket, "connect", _connecting_to)
        setattr(socket.socket, "connect_ex", _connecting_to_ex)
