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
import hashlib
import inspect
import json
from collections import Counter
from collections.abc import AsyncIterator, Callable, Coroutine, Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from enum import Enum
from types import SimpleNamespace
from typing import Any, Protocol, TypeVar, cast
from unittest.mock import patch

from tests.e2e.s3_mock import CONDITION_KEYS, S3_SESSION, MultiBucketS3Client
from tests.sim.loop import SimLoop
from tests.sim.rand import exponential
from tests.sim.trace import (
    STEP,
    Change,
    Requested,
    Served,
    StepRef,
    Trace,
    state_of,
)

T = TypeVar("T")

S3_OPS = frozenset(
    name
    for name, member in vars(MultiBucketS3Client).items()
    if inspect.iscoroutinefunction(member) and not name.startswith("_")
)

GDRIVE_OPS = frozenset({
    "list_files",
    "list_children",
    "list_shared_drives",
    "list_all_files",
    "get_file",
    "download_file",
    "download_file_stream",
    "capture_file_metadata",
    "upload_file",
    "update_file_content",
    "create_folder",
})

SLACK_OPS = frozenset({
    "conversations.list",
    "conversations.history",
    "users.list",
    "users.info",
    "auth.test",
    "download_file",
    "download_file_stream",
})

GITHUB_OPS = frozenset({
    "fetch_default_branch",
    "fetch_tree",
    "read_bytes",
    "search_code",
    "graphql_data",
})

DROPBOX_OPS = frozenset({
    "dropbox:/files/list_folder",
    "dropbox:/files/get_metadata",
    "dropbox:download",
    "dropbox:upload",
    "dropbox:/files/delete_v2",
    "dropbox:/files/move_v2",
    "dropbox:/files/copy_v2",
})

DISCORD_OPS = frozenset({
    "list_guilds",
    "list_channels",
    "list_members",
    "list_messages_for_day",
    "download_file",
    "download_file_stream",
})

KNOWN_OPS = (
    S3_OPS | GDRIVE_OPS | SLACK_OPS | GITHUB_OPS | DROPBOX_OPS | DISCORD_OPS
)


class Leg(Enum):
    """A request's trip to the store, or its answer's trip back."""

    OUT = "out"
    BACK = "back"


class Latency(Protocol):
    """How long one leg of one request takes, in virtual seconds."""

    def __call__(
        self, step: StepRef | None, op: str, key: str, nth: int, leg: Leg
    ) -> float:
        """The leg's delay.

        Args:
            step (StepRef | None): the line that sent the request.
            op (str): the client method.
            key (str): the object key.
            nth (int): how many requests with the same step, op and key
                came before it.
            leg (Leg): out to the store or back to the caller.
        """
        ...


def immediate(
    step: StepRef | None, op: str, key: str, nth: int, leg: Leg
) -> float:
    """No latency: order comes from the script's awaits and holds.

    Args:
        step (StepRef | None): the line that sent the request.
        op (str): the client method.
        key (str): the object key.
        nth (int): how many requests with the same step, op and key
            came before it.
        leg (Leg): out to the store or back to the caller.
    """
    del step, op, key, nth, leg
    return 0.0


@dataclass(frozen=True, slots=True)
class Exponential:
    """Keyed exponential latency: a leg's draw depends on who sent it,
    from which line, for what, and how many times, and nothing else.

    Args:
        seed (int): the run's seed.
        mean (float): the mean leg, in virtual seconds.
    """

    seed: int
    mean: float = 0.005

    def __call__(
        self, step: StepRef | None, op: str, key: str, nth: int, leg: Leg
    ) -> float:
        who = (step.actor, step.step) if step is not None else ("-", -1)
        return exponential(
            self.seed, self.mean, "latency", *who, op, key, nth, leg.value
        )


@dataclass(frozen=True, slots=True)
class Match:
    """Which requests a hold applies to.

    Args:
        op (str | None): the client method, None for any.
        key (str | None): the object key, None for any.
        actor (str | None): the sending actor, None for any.
        nth (int | None): which fitting request, counted from 0; None
            for the first.
    """

    op: str | None = None
    key: str | None = None
    actor: str | None = None
    nth: int | None = None

    def fits(self, step: StepRef | None, op: str, key: str) -> bool:
        """Whether a request fits, ignoring ``nth``.

        Args:
            step (StepRef | None): the line that sent it.
            op (str): the client method.
            key (str): the object key.
        """
        actor = step.actor if step is not None else None
        return (
            (self.op is None or self.op == op)
            and (self.key is None or self.key == key)
            and (self.actor is None or self.actor == actor)
        )


class Hold:
    """A request held before it reaches the store.

    Released by ``release()``, or, with ``until``, once a request
    matching ``until`` arrives or nothing else can happen at this
    instant, so a hold a fix makes pointless never hangs. A request
    cancelled while held releases it.

    Args:
        match (Match): which request to hold.
        until (Match | None): the request that releases it.
    """

    def __init__(self, match: Match, until: Match | None) -> None:
        self.match = match
        self.until = until
        self.hits = 0
        self.released = False
        self._gate: asyncio.Future[None] | None = None
        self._what = ""

    @property
    def reached(self) -> bool:
        """Whether the matching request is waiting at the hold."""
        return self._gate is not None and not self.released

    def release(self) -> None:
        """Let the held request go on; later ones pass untouched."""
        self.released = True
        if self._gate is not None and not self._gate.done():
            self._gate.set_result(None)

    def takes(self, step: StepRef | None, op: str, key: str) -> bool:
        """Count a fitting request; whether it is the one to hold.

        Args:
            step (StepRef | None): the line that sent it.
            op (str): the client method.
            key (str): the object key.
        """
        if self.released or self._gate is not None:
            return False
        if not self.match.fits(step, op, key):
            return False
        self.hits += 1
        return self.match.nth is None or self.match.nth == self.hits - 1

    async def wait(self, what: str) -> None:
        """Park the request here until released.

        Args:
            what (str): the request, for a deadlock report.
        """
        self._what = what
        self._gate = asyncio.get_running_loop().create_future()
        try:
            await self._gate
        finally:
            self.released = True

    def describe(self) -> str:
        """The held request, for a deadlock report."""
        return f"{self._what} held by {self.match}"


def _key_of(op: str, kwargs: dict[str, Any]) -> str:
    if op == "delete_objects":
        listed = kwargs.get("Delete", {}).get("Objects", [])
        return str(listed[0]["Key"]) if listed else ""
    for candidate in (
        "Key",
        "Prefix",
        "file_id",
        "folder_id",
        "folder_ids",
        "guild_id",
        "channel_id",
        "sha",
        "ref",
        "url",
        "path",
        "from_path",
        "name",
        "channel",
        "query",
    ):
        if candidate in kwargs and kwargs[candidate]:
            val = kwargs[candidate]
            if isinstance(val, (list, tuple)):
                return str(val[0]) if val else ""
            return str(val)
    return ""


def _at_once(call: Coroutine[Any, Any, T]) -> T:
    """Run ``call`` to its end without yielding to the loop.

    A request then takes effect at one instant, so the changes it is
    traced with are its own. A fake that suspends inside a request,
    such as through an async ``before`` hook, is refused.

    Args:
        call (Coroutine[Any, Any, T]): the fake's method, not started.

    Raises:
        RuntimeError: the fake suspended.
    """
    try:
        call.send(None)
    except StopIteration as done:
        return cast(T, done.value)
    call.close()
    raise RuntimeError("the S3 fake suspended inside a request")


def _code(exc: Exception) -> str:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        return str(response.get("Error", {}).get("Code", type(exc).__name__))
    return type(exc).__name__


class Network:
    """The one place a request is delayed, held and traced.

    Each request: trace it, sleep the out leg, wait at a hold, apply it
    to the store at once, trace what changed, sleep the return leg.

    Args:
        trace (Trace): where events go.
        latency (Latency): each leg's delay.
        store (MultiBucketS3Client): the shared in-memory store.
    """

    def __init__(
        self, trace: Trace, latency: Latency, store: MultiBucketS3Client
    ) -> None:
        self._trace = trace
        self._latency = latency
        self._store = store
        self._holds: list[Hold] = []
        self._seen: Counter[tuple[StepRef | None, str, str]] = Counter()
        self._seq = 0
        self._watching = False

    def hold(self, match: Match, until: Match | None = None) -> Hold:
        """Hold the request ``match`` names before it reaches the store.

        Args:
            match (Match): which request.
            until (Match | None): the request that releases it, None to
                release it only by hand.

        Raises:
            ValueError: a match names an op the store does not have, or
                ``until`` is asked for under latency, where every leg is
                a timer and "nothing else can happen" comes too early.
            TypeError: the running loop is not a ``SimLoop``.
        """
        for named in (match, until):
            if named is not None and named.op not in (None, *KNOWN_OPS):
                raise ValueError(f"no such S3 op: {named.op!r}")
        if until is not None and self._latency is not immediate:
            raise ValueError("a hold with until needs immediate latency")
        loop = asyncio.get_running_loop()
        if not isinstance(loop, SimLoop):
            raise TypeError("a hold needs the simulator's loop")
        if not self._watching:
            loop.watch_idle(self._release_waiting, self.held)
            self._watching = True
        hold = Hold(match, until)
        self._holds.append(hold)
        return hold

    def held(self) -> tuple[str, ...]:
        """Every request waiting at a hold."""
        return tuple(h.describe() for h in self._holds if h.reached)

    def _release_waiting(self) -> bool:
        waiting = [h for h in self._holds if h.reached and h.until is not None]
        for hold in waiting:
            hold.release()
        return bool(waiting)

    def _snapshot(self) -> dict[tuple[str, str], bytes]:
        if not hasattr(self._store, "buckets"):
            return {}
        return {
            (bucket, key): data
            for bucket, objects in self._store.buckets.items()
            for key, data in objects.items()
        }

    def _changes(
        self,
        before: dict[tuple[str, str], bytes],
        commits: dict[tuple[str, str], int],
    ) -> tuple[Change, ...]:
        if not hasattr(self._store, "commits"):
            return ()
        after = self._snapshot()
        return tuple(
            Change(
                key,
                state_of(before.get((bucket, key))),
                state_of(after.get((bucket, key))),
                count,
            )
            for (bucket, key), count in sorted(self._store.commits.items())
            if commits.get((bucket, key)) != count
        )

    async def request(
        self,
        op: str,
        kwargs: dict[str, Any],
        perform: Callable[[], Coroutine[Any, Any, T]],
    ) -> T:
        """Carry one request to the store and its answer back.

        Args:
            op (str): the client method.
            kwargs (dict[str, Any]): its arguments.
            perform (Callable[[], Coroutine[Any, Any, T]]): the fake's
                method, run to its end in one step so it takes effect
                atomically.
        """
        step = STEP.get()
        key = _key_of(op, kwargs)
        sent = tuple(
            (k, str(kwargs[k])) for k in CONDITION_KEYS if k in kwargs
        )
        nth = self._seen[step, op, key]
        self._seen[step, op, key] += 1
        self._seq += 1
        seq = self._seq
        loop = asyncio.get_running_loop()
        self._trace.append(Requested(seq, loop.time(), step, op, key, sent))
        await asyncio.sleep(self._latency(step, op, key, nth, Leg.OUT))
        for hold in self._holds:
            if hold.reached and hold.until is not None:
                if hold.until.fits(step, op, key):
                    hold.release()
        for hold in self._holds:
            if hold.takes(step, op, key):
                await hold.wait(f"{step} {op} {key}")
        before = self._snapshot()
        commits = dict(self._store.commits) if hasattr(self._store, "commits") else {}
        try:
            answer = _at_once(perform())
        except Exception as exc:
            self._trace.append(
                Served(seq, loop.time(), step, op, key, sent, (), _code(exc))
            )
            await asyncio.sleep(self._latency(step, op, key, nth, Leg.BACK))
            raise
        changes = self._changes(before, commits)
        self._trace.append(
            Served(seq, loop.time(), step, op, key, sent, changes, None)
        )
        await asyncio.sleep(self._latency(step, op, key, nth, Leg.BACK))
        return answer


class _Paginator:
    def __init__(self, network: Network, inner: Any) -> None:
        self._network = network
        self._inner = inner

    async def paginate(self, **kwargs: Any) -> AsyncIterator[dict[str, Any]]:
        pages: list[dict[str, Any]] = []

        async def collect() -> None:
            async for page in self._inner.paginate(**kwargs):
                pages.append(page)

        await self._network.request("list_objects_v2", kwargs, collect)
        for page in pages:
            yield page


class Connection:
    """What a mount's S3 client is in a run: every awaited method of the
    shared fake becomes one ``Network.request``, by ``__getattr__``, so
    no method list is kept in sync with the fake.

    Args:
        network (Network): the gate.
        fake (Any): the shared store.
        endpoint (str): the endpoint the client reports.
    """

    def __init__(
        self, network: Network, fake: Any, endpoint: str
    ) -> None:
        self._network = network
        self._fake = fake
        self.meta = SimpleNamespace(endpoint_url=endpoint)

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._fake, name)
        if name == "get_paginator":
            return lambda op: _Paginator(self._network, attr(op))
        if inspect.isasyncgenfunction(attr):
            async def gen_call(*args: Any, **kwargs: Any) -> AsyncIterator[Any]:
                async def perform() -> Any:
                    return attr(*args, **kwargs)

                gen = await self._network.request(name, kwargs, perform)
                async for item in gen:
                    yield item

            return gen_call
        if not inspect.iscoroutinefunction(attr):
            return attr

        async def call(*args: Any, **kwargs: Any) -> Any:
            return await self._network.request(
                name, kwargs, lambda: attr(*args, **kwargs)
            )

        return call

    async def __aenter__(self) -> "Connection":
        return self

    async def __aexit__(self, *args: Any) -> None:
        del args


class _Session:
    def __init__(self, network: Network, fake: MultiBucketS3Client) -> None:
        self._network = network
        self._fake = fake

    def client(self, **kwargs: Any) -> Connection:
        endpoint = kwargs.get("endpoint_url") or "https://s3.amazonaws.com"
        return Connection(self._network, self._fake, endpoint)


@contextmanager
def route_s3(network: Network, fake: MultiBucketS3Client) -> Iterator[None]:
    """Open every S3 client of the run through ``network``.

    Args:
        network (Network): the gate.
        fake (MultiBucketS3Client): the shared store.
    """
    session = _Session(network, fake)
    with patch(S3_SESSION, side_effect=lambda config: session):
        yield


class _NoYield:
    def __await__(self) -> Iterator[None]:
        if False:
            yield
        return None


class _SlackConnection:
    def __init__(self, network: Network, fake: Any) -> None:
        self._network = network
        self._fake = fake

    async def get(
        self, accessor: Any, method: str, params: Any = None
    ) -> Any:
        async def perform() -> Any:
            with patch("asyncio.sleep", return_value=_NoYield()):
                if method == "users.info":
                    from tests.core.slack.conftest import USERS

                    uid = (params or {}).get("user")
                    for u in USERS:
                        if u.get("id") == uid:
                            return {"ok": True, "user": u}
                    return {"ok": True, "user": USERS[0]}
                return await self._fake.get(accessor, method, params)

        return await self._network.request(
            method,
            params or {},
            perform,
        )

    async def download(
        self, accessor: Any, url: str, offset: int = 0, size: Any = None
    ) -> bytes:
        return await self._network.request(
            "download_file",
            {"url": url, "offset": offset, "size": size},
            lambda: self._fake.download(accessor, url, offset, size),
        )

    async def download_stream(
        self, accessor: Any, url: str
    ) -> AsyncIterator[bytes]:
        data = await self.download(accessor, url, 0, None)
        yield data


@contextmanager
def route_gdrive(network: Network, fake: Any) -> Iterator[None]:
    """Route Google Drive requests through ``network``.

    Args:
        network (Network): the gate.
        fake: the FakeGDrive instance.
    """
    from mirage.accessor.google_api import GoogleApiAccessor
    from tests.e2e.gdrive_mock import (
        FakeDriveApi,
        FakeRenderApi,
        _FAKE_EXPIRES_IN,
        _FAKE_TOKEN,
    )

    registry = [(None, fake)]
    drive = FakeDriveApi(fake, registry)
    conn = Connection(network, drive, "https://www.googleapis.com")

    async def fake_refresh(_config: Any) -> tuple[str, int]:
        return _FAKE_TOKEN, _FAKE_EXPIRES_IN

    with ExitStack() as stack:
        stack.enter_context(
            patch.object(
                GoogleApiAccessor,
                "drive",
                property(lambda accessor: conn),
            )
        )
        for service in ("docs", "sheets", "slides"):
            stack.enter_context(
                patch.object(
                    GoogleApiAccessor,
                    service,
                    property(lambda accessor: FakeRenderApi(cast(Any, conn))),
                )
            )
        stack.enter_context(
            patch(
                "mirage.core.google.client.refresh_access_token",
                new=fake_refresh,
            )
        )
        yield


@contextmanager
def route_slack(network: Network, fake: Any) -> Iterator[None]:
    """Route Slack requests through ``network``.

    Args:
        network (Network): the gate.
        fake: the FakeSlack instance.
    """
    conn = _SlackConnection(network, fake)
    with ExitStack() as stack:
        for module in (
            "client",
            "paginate",
            "readdir",
            "users",
            "history",
            "react",
            "emoji",
            "pins",
            "search",
            "events.hook",
        ):
            stack.enter_context(
                patch(
                    f"mirage.core.slack.{module}.slack_get",
                    new=conn.get,
                )
            )
        stack.enter_context(
            patch(
                "mirage.core.slack.read.download_file",
                new=conn.download,
            )
        )
        stack.enter_context(
            patch(
                "mirage.core.slack.read.download_file_stream",
                new=conn.download_stream,
            )
        )
        stack.enter_context(
            patch(
                "mirage.core.slack.client.download_file",
                new=conn.download,
            )
        )
        stack.enter_context(
            patch(
                "mirage.core.slack.client.download_file_stream",
                new=conn.download_stream,
            )
        )
        yield


class _GitHubConnection:
    def __init__(
        self,
        network: Network,
        tree: dict[str, Any],
        blobs: dict[str, bytes],
        default_branch: str = "main",
    ) -> None:
        self._network = network
        self._tree = tree
        self._blobs = blobs
        self._default_branch = default_branch

    async def fetch_default_branch(
        self, account: Any, owner: str, repo: str
    ) -> str:
        async def perform() -> str:
            return self._default_branch

        return await self._network.request(
            "fetch_default_branch",
            {"owner": owner, "repo": repo},
            perform,
        )

    async def fetch_tree(
        self, account: Any, owner: str, repo: str, ref: str
    ) -> tuple[dict[str, Any], bool, Any]:
        async def perform() -> tuple[dict[str, Any], bool, Any]:
            return (dict(self._tree), False, None)

        return await self._network.request(
            "fetch_tree",
            {"owner": owner, "repo": repo, "ref": ref},
            perform,
        )

    async def read_bytes(
        self, account: Any, owner: str, repo: str, sha: str
    ) -> bytes:
        async def perform() -> bytes:
            return self._blobs[sha]

        return await self._network.request(
            "read_bytes",
            {"owner": owner, "repo": repo, "sha": sha},
            perform,
        )

    async def stream_blob(
        self, account: Any, owner: str, repo: str, sha: str
    ) -> AsyncIterator[bytes]:
        data = await self.read_bytes(account, owner, repo, sha)
        yield data

    async def graphql_data(
        self, account: Any, query: str, variables: dict[str, Any]
    ) -> dict[str, Any]:
        async def perform() -> dict[str, Any]:
            repo_res: dict[str, Any] = {}
            for k, v in variables.items():
                if k in ("owner", "repo"):
                    continue
                sha = str(v)
                raw = self._blobs.get(sha, b"")
                try:
                    text = raw.decode("utf-8")
                    repo_res[k] = {"text": text, "isTruncated": False}
                except UnicodeDecodeError:
                    pass
            return {"repository": repo_res}

        return await self._network.request(
            "graphql_data",
            variables,
            perform,
        )

    async def search_code(
        self,
        account: Any,
        owner: str,
        repo: str,
        query: str,
        path_filter: str | None = None,
    ) -> tuple[list[Any], bool]:
        from tests.fixtures.github_mock import MOCK_SEARCH_RESULTS

        async def perform() -> tuple[list[Any], bool]:
            results = MOCK_SEARCH_RESULTS.get(query, [])
            if path_filter:
                results = [r for r in results if r.path.startswith(path_filter)]
            return list(results), False

        return await self._network.request(
            "search_code",
            {
                "owner": owner,
                "repo": repo,
                "query": query,
                "path_filter": path_filter,
            },
            perform,
        )


@contextmanager
def route_github(
    network: Network,
    tree: dict[str, Any] | None = None,
    blobs: dict[str, bytes] | None = None,
    default_branch: str = "main",
) -> Iterator[None]:
    """Route GitHub requests through ``network``.

    Args:
        network (Network): the gate.
        tree (dict[str, Any] | None): mock tree entries.
        blobs (dict[str, bytes] | None): mock blob sha-to-bytes map.
        default_branch (str): default branch name.
    """
    from tests.fixtures.github_mock import (
        MOCK_BLOBS,
        MOCK_DEFAULT_BRANCH,
        MOCK_TREE,
    )

    mock_tree = MOCK_TREE if tree is None else tree
    mock_blobs = MOCK_BLOBS if blobs is None else blobs
    mock_branch = MOCK_DEFAULT_BRANCH if default_branch is None else default_branch

    conn = _GitHubConnection(network, mock_tree, mock_blobs, mock_branch)
    with ExitStack() as stack:
        stack.enter_context(
            patch(
                "mirage.core.github.repo.fetch_default_branch",
                new=conn.fetch_default_branch,
            )
        )
        stack.enter_context(
            patch(
                "mirage.core.github.tree.fetch_tree",
                new=conn.fetch_tree,
            )
        )
        stack.enter_context(
            patch(
                "mirage.core.github.read.read_bytes",
                new=conn.read_bytes,
            )
        )
        stack.enter_context(
            patch(
                "mirage.core.github.read.stream_blob",
                new=conn.stream_blob,
            )
        )
        stack.enter_context(
            patch(
                "mirage.core.github.client.stream_blob",
                new=conn.stream_blob,
            )
        )
        stack.enter_context(
            patch(
                "mirage.core.github.read.graphql_data",
                new=conn.graphql_data,
            )
        )
        stack.enter_context(
            patch(
                "mirage.core.github.repo.graphql_data",
                new=conn.graphql_data,
            )
        )
        stack.enter_context(
            patch(
                "mirage.core.github.search.search_code",
                new=conn.search_code,
            )
        )
        yield


class _DropboxConnection:
    def __init__(self, network: Network, files: dict[str, bytes]) -> None:
        self._network = network
        self.files = {("/" + k.strip("/")): v for k, v in files.items()}
        self._revs: dict[str, int] = {k: 1 for k in self.files}

    def _folders(self) -> set[str]:
        out = {"/"}
        for key in self.files:
            parts = key.strip("/").split("/")[:-1]
            for i in range(1, len(parts) + 1):
                out.add("/" + "/".join(parts[:i]))
        return out

    async def rpc(
        self, tm: Any, endpoint: str, body: dict[str, Any] | None
    ) -> dict[str, Any]:
        body = body or {}

        async def perform() -> dict[str, Any]:
            if endpoint == "/files/list_folder":
                p = "/" + body.get("path", "").strip("/")
                if p not in self._folders():
                    from mirage.core.dropbox.client import DropboxApiError

                    raise DropboxApiError(
                        f"not found: {p}", 409, summary="path/not_found"
                    )
                p_pfx = "/" if p == "/" else p.rstrip("/") + "/"
                entries: list[dict[str, Any]] = []
                dirs_seen: set[str] = set()
                for fpath, data in sorted(self.files.items()):
                    if fpath.startswith(p_pfx):
                        rel = fpath[len(p_pfx) :]
                        if "/" in rel:
                            dname = rel.split("/")[0]
                            if dname not in dirs_seen:
                                dirs_seen.add(dname)
                                entries.append({
                                    ".tag": "folder",
                                    "name": dname,
                                    "path_lower": f"{p_pfx}{dname}".lower(),
                                    "path_display": f"{p_pfx}{dname}",
                                })
                        else:
                            rev = str(self._revs.get(fpath, 1))
                            chash = hashlib.sha256(data).hexdigest()
                            entries.append({
                                ".tag": "file",
                                "name": rel,
                                "path_lower": fpath.lower(),
                                "path_display": fpath,
                                "id": f"id:{rel}",
                                "size": len(data),
                                "rev": rev,
                                "content_hash": chash,
                            })
                return {"entries": entries, "has_more": False}
            if endpoint == "/files/get_metadata":
                p = "/" + body.get("path", "").strip("/")
                if p in self.files:
                    name = p.rsplit("/", 1)[-1]
                    content = self.files[p]
                    rev = str(self._revs.get(p, 1))
                    chash = hashlib.sha256(content).hexdigest()
                    return {
                        ".tag": "file",
                        "name": name,
                        "path_lower": p.lower(),
                        "path_display": p,
                        "id": f"id:{name}",
                        "size": len(content),
                        "rev": rev,
                        "content_hash": chash,
                    }
                if p in self._folders():
                    name = p.rsplit("/", 1)[-1] if p != "/" else ""
                    return {
                        ".tag": "folder",
                        "name": name,
                        "path_lower": p.lower(),
                        "path_display": p,
                        "id": f"id:{name or 'root'}",
                    }
                from mirage.core.dropbox.client import DropboxApiError

                raise DropboxApiError(
                    f"not found: {p}", 409, summary="path/not_found"
                )
            if endpoint == "/files/delete_v2":
                p = "/" + body.get("path", "").strip("/")
                to_delete = [
                    f for f in self.files if f == p or f.startswith(p + "/")
                ]
                if not to_delete:
                    from mirage.core.dropbox.client import DropboxApiError

                    raise DropboxApiError(
                        f"not found: {p}", 409, summary="path/not_found"
                    )
                for f in to_delete:
                    del self.files[f]
                    self._revs.pop(f, None)
                name = p.rsplit("/", 1)[-1]
                return {
                    "metadata": {
                        ".tag": "file",
                        "name": name,
                        "path_lower": p.lower(),
                        "path_display": p,
                        "id": f"id:{name}",
                    }
                }
            return {}

        return await self._network.request(
            f"dropbox:{endpoint}",
            body,
            perform,
        )

    async def download(
        self, tm: Any, path: str, window: Any = None
    ) -> tuple[bytes, str | None]:
        import json

        p = "/" + path.strip("/")

        async def perform() -> tuple[bytes, str | None]:
            if p not in self.files:
                from mirage.core.dropbox.client import DropboxApiError

                raise DropboxApiError(
                    f"not found: {p}", 409, summary="path/not_found"
                )
            content = self.files[p]
            rev = str(self._revs.get(p, 1))
            chash = hashlib.sha256(content).hexdigest()
            return content, json.dumps({"rev": rev, "content_hash": chash})

        return await self._network.request(
            "dropbox:download",
            {"path": path},
            perform,
        )

    async def download_stream(
        self,
        tm: Any,
        path: str,
        chunk_size: int = 65536,
        on_response: Any = None,
        **kwargs: Any,
    ) -> AsyncIterator[bytes]:
        data, res_hdr = await self.download(tm, path)
        if on_response is not None and res_hdr is not None:
            on_response({
                "Dropbox-API-Result": res_hdr,
                "dropbox-api-result": res_hdr,
            })
        yield data

    async def upload(
        self, tm: Any, path: str, data: Any, mode: Any = None
    ) -> dict[str, Any]:
        p = "/" + path.strip("/")
        content = data if isinstance(data, bytes) else bytes(data)

        async def perform() -> dict[str, Any]:
            self.files[p] = content
            self._revs[p] = self._revs.get(p, 0) + 1
            rev = str(self._revs[p])
            chash = hashlib.sha256(content).hexdigest()
            name = p.rsplit("/", 1)[-1]
            return {
                ".tag": "file",
                "name": name,
                "path_lower": p.lower(),
                "path_display": p,
                "id": f"id:{name}",
                "size": len(content),
                "rev": rev,
                "content_hash": chash,
            }

        return await self._network.request(
            "dropbox:upload",
            {"path": path, "size": len(content)},
            perform,
        )


@contextmanager
def route_dropbox(
    network: Network, files: dict[str, bytes] | Any
) -> Iterator[None]:
    """Route Dropbox requests through ``network``.

    Args:
        network (Network): the gate.
        files: dict of Dropbox path -> bytes or FakeDropbox.
    """
    file_map = files.files if hasattr(files, "files") else dict(files)
    conn = _DropboxConnection(network, file_map)

    async def fake_refresh(_config: Any) -> tuple[str, int]:
        return "fake-dropbox-token", 3600

    with ExitStack() as stack:
        for mod in ("client", "api", "capacity"):
            stack.enter_context(
                patch(f"mirage.core.dropbox.{mod}.dropbox_rpc", new=conn.rpc)
            )
        for mod in ("client", "read"):
            stack.enter_context(
                patch(
                    f"mirage.core.dropbox.{mod}.dropbox_download",
                    new=conn.download,
                )
            )
            stack.enter_context(
                patch(
                    f"mirage.core.dropbox.{mod}.dropbox_download_stream",
                    new=conn.download_stream,
                )
            )
        for mod in ("client", "write"):
            stack.enter_context(
                patch(
                    f"mirage.core.dropbox.{mod}.dropbox_upload", new=conn.upload
                )
            )
        stack.enter_context(
            patch(
                "mirage.core.dropbox.client.refresh_access_token",
                new=fake_refresh,
            )
        )
        yield


class _DiscordConnection:
    def __init__(self, network: Network, fake: Any) -> None:
        self._network = network
        self._fake = fake

    async def list_guilds(self, accessor: Any) -> Any:
        return await self._network.request(
            "list_guilds",
            {},
            lambda: self._fake.list_guilds(accessor),
        )

    async def list_channels(self, accessor: Any, guild_id: str) -> Any:
        return await self._network.request(
            "list_channels",
            {"guild_id": guild_id},
            lambda: self._fake.list_channels(accessor, guild_id),
        )

    async def list_members(
        self, accessor: Any, guild_id: str, stop_at: Any = None
    ) -> Any:
        return await self._network.request(
            "list_members",
            {"guild_id": guild_id},
            lambda: self._fake.list_members(accessor, guild_id, stop_at),
        )

    async def list_messages_for_day(
        self, accessor: Any, channel_id: str, date_str: str, scope: Any
    ) -> Any:
        return await self._network.request(
            "list_messages_for_day",
            {"channel_id": channel_id, "date_str": date_str},
            lambda: self._fake.list_messages_for_day(
                accessor, channel_id, date_str, scope
            ),
        )

    async def download_file(
        self, accessor: Any, url: str, offset: int = 0, size: Any = None
    ) -> bytes:
        return await self._network.request(
            "download_file",
            {"url": url, "offset": offset, "size": size},
            lambda: self._fake.download_file(accessor, url, offset, size),
        )

    async def download_file_stream(
        self, accessor: Any, url: str
    ) -> AsyncIterator[bytes]:
        data = await self.download_file(accessor, url, 0, None)
        yield data


@contextmanager
def route_discord(network: Network, fake: Any) -> Iterator[None]:
    """Route Discord requests through ``network``.

    Args:
        network (Network): the gate.
        fake: FakeDiscordApi instance.
    """
    import mirage.core.discord.history as history_mod
    import mirage.core.discord.read as read_mod
    import mirage.core.discord.readdir as readdir_mod

    conn = _DiscordConnection(network, fake)
    with ExitStack() as stack:
        stack.enter_context(
            patch.object(readdir_mod, "list_guilds", new=conn.list_guilds)
        )
        stack.enter_context(
            patch.object(readdir_mod, "list_channels", new=conn.list_channels)
        )
        stack.enter_context(
            patch.object(readdir_mod, "list_members", new=conn.list_members)
        )
        stack.enter_context(
            patch.object(
                history_mod,
                "list_messages_for_day",
                new=conn.list_messages_for_day,
            )
        )
        stack.enter_context(
            patch.object(read_mod, "list_members", new=conn.list_members)
        )
        stack.enter_context(
            patch.object(read_mod, "download_file", new=conn.download_file)
        )
        stack.enter_context(
            patch.object(
                read_mod, "download_file_stream", new=conn.download_file_stream
            )
        )
        for mod in ("read", "files"):
            stack.enter_context(
                patch(
                    f"mirage.core.discord.{mod}.download_file",
                    new=conn.download_file,
                )
            )
            stack.enter_context(
                patch(
                    f"mirage.core.discord.{mod}.download_file_stream",
                    new=conn.download_file_stream,
                )
            )
        yield
