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
import json
import os
import sys
import tempfile
from collections.abc import AsyncGenerator
from functools import partial
from pathlib import Path
from typing import Protocol

import aiohttp
from aiohttp import web
from backends import BUILDERS as BACKEND_BUILDERS
from webhook_server import make_app

from mirage import MountMode, Workspace
from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.disk.events import DiskEventHook
from mirage.events import DeltaHook, EventHub, RAMEventQueue
from mirage.types import FileEvent, PathSpec
from mirage.vfs.nextcloud import NextcloudConfig, NextcloudVFS

CASE_DIR = Path(__file__).resolve().parent
DEFAULT_RESULTS_FILE = (
    Path(tempfile.gettempdir()) / "events-battery-results.txt"
)

ALL_MODES = ("ping", "push", "event")
EVENT_TIMEOUT = 20.0
ABSENT_WINDOW = 1.0
PUMP_WINDOW = EVENT_TIMEOUT / 2
PUMP_INTERVAL = 0.25
PROBE_TIMEOUT = 5.0
CLASS_BY_KIND = {
    "create": "OCP\\Files\\Events\\Node\\NodeCreatedEvent",
    "update": "OCP\\Files\\Events\\Node\\NodeWrittenEvent",
    "delete": "OCP\\Files\\Events\\Node\\NodeDeletedEvent",
    "move": "OCP\\Files\\Events\\Node\\NodeRenamedEvent",
}


class ExternalWriter(Protocol):
    """The backend-mutation surface every battery writes through.

    Satisfied by the opendal operator the Nextcloud battery uses and by
    the writers in ``backends.py`` that mirror it, so ``_mutate`` and
    ``_seed`` need no per-backend branch.
    """

    async def create_dir(self, path: str) -> None: ...

    async def write(self, path: str, data: bytes) -> None: ...

    async def delete(self, path: str) -> None: ...

    async def rename(self, path: str, to: str) -> None: ...

    async def remove_all(self, path: str) -> None: ...


def _nextcloud_config(url: str) -> NextcloudConfig:
    """Build a NextcloudConfig for ``url`` from the deployment env.

    Args:
        url (str): WebDAV endpoint the mount is rooted at.
    """
    return NextcloudConfig(
        url=url,
        username=os.environ.get("NEXTCLOUD_USERNAME", "admin"),
        password=os.environ.get("NEXTCLOUD_PASSWORD", "admin123"),
    )


async def _build_nextcloud(
    spec: dict,
) -> tuple[Workspace, ExternalWriter] | None:
    """Build the subscribed workspace and a separate external writer.

    Returns None when the deployment env is absent, so a local run
    without a Nextcloud server skips instead of failing.

    Args:
        spec (dict): Parsed case file.
    """
    url = os.environ.get("NEXTCLOUD_URL")
    if not url:
        return None
    config = _nextcloud_config(url)
    ws = Workspace({spec["mount"]: NextcloudVFS(config)}, mode=MountMode.WRITE)
    external = NextcloudAccessor(config).operator()
    return ws, external


async def _build_nextcloud_nested(
    spec: dict,
) -> tuple[Workspace, ExternalWriter] | None:
    """Build the nested-mount battery's workspace: the outer mount at
    the account root plus a second mount, rooted at a subfolder of the
    same account, nested inside the outer mount's subtree.

    Args:
        spec (dict): Parsed case file (needs a ``nested`` block).
    """
    url = os.environ.get("NEXTCLOUD_URL")
    if not url:
        return None
    block = spec["nested"]
    inner_url = url.rstrip("/") + "/" + block["inner_root"].strip("/") + "/"
    outer = _nextcloud_config(url)
    ws = Workspace(
        {
            spec["mount"]: NextcloudVFS(outer),
            block["inner_mount"]: NextcloudVFS(_nextcloud_config(inner_url)),
        },
        mode=MountMode.WRITE,
    )
    external = NextcloudAccessor(outer).operator()
    return ws, external


BUILDERS = {"nextcloud": _build_nextcloud, **BACKEND_BUILDERS}


def _files_prefix() -> str:
    """The ``/<user>/files`` prefix Nextcloud puts in webhook paths."""
    return f"/{os.environ.get('NEXTCLOUD_USERNAME', 'admin')}/files"


def _root_rel(spec: dict) -> str:
    """The root as the external writer spells it, mount-relative.

    Args:
        spec (dict): Parsed case file.
    """
    return spec["root"][len(spec["mount"].rstrip("/")) :].strip("/")


def _framed_root(spec: dict) -> PathSpec:
    """Build the mount-framed root root the delta hook pulls over.

    Args:
        spec (dict): Parsed case file.
    """
    return PathSpec.from_str_path(spec["root"], vfs_path=_root_rel(spec))


async def _mutate(op: ExternalWriter, mutate: dict) -> None:
    """Apply one mutation directly to the backend, bypassing the
    subscribed workspace so its cache is genuinely stale.

    Args:
        op (ExternalWriter): opendal operator of a separate
            accessor.
        mutate (dict): {"op", "path", "body"?}.
    """
    if mutate["op"] == "write":
        parent = mutate["path"].rsplit("/", 1)[0]
        if parent:
            await op.create_dir(parent + "/")
        await op.write(mutate["path"], mutate["body"].encode())
    elif mutate["op"] == "delete":
        await op.delete(mutate["path"])
    elif mutate["op"] == "rename":
        await op.rename(mutate["path"], mutate["to"])
    else:
        raise ValueError(f"unknown mutate op: {mutate['op']}")


def _webhook_payload(expect: dict, mount: str) -> dict:
    """Build the Nextcloud payload a real webhook_listeners would send.

    Args:
        expect (dict): Case ``expect`` block ({"kind", "path"}).
        mount (str): Mirage mount root.
    """
    rel = expect["path"][len(mount.rstrip("/")) :]
    node_path = _files_prefix() + rel
    if expect["kind"] == "move":
        prev_rel = expect["previous"][len(mount.rstrip("/")) :]
        return {
            "event": {
                "class": CLASS_BY_KIND["move"],
                "source": {"id": 1, "path": _files_prefix() + prev_rel},
                "target": {"id": 1, "path": node_path},
            },
            "time": 1700000000,
        }
    return {
        "event": {
            "class": CLASS_BY_KIND[expect["kind"]],
            "node": {"id": 1, "path": node_path},
        },
        "time": 1700000000,
    }


class EventStream:
    """Consume an events iterator with an always-armed pending task.

    Arming before any mutation matters: an async generator body (which
    registers the subscriber) only runs on the first ``__anext__``, so
    consuming lazily would lose events notified before the first await.
    """

    def __init__(self, agen: AsyncGenerator[FileEvent, None]) -> None:
        self._agen = agen
        self._task: asyncio.Task[FileEvent] | None = None

    async def start(self) -> None:
        """Arm the iterator and yield to the loop so the subscriber
        registers before the first mutation."""
        self._arm()
        await asyncio.sleep(0.05)

    def _arm(self) -> None:
        if self._task is None:
            self._task = asyncio.ensure_future(self._agen.__anext__())

    async def expect(self, want_path: str) -> FileEvent | None:
        """Return the next change for ``want_path``, skipping others
        (a nested create also emits its parent dir), or None only when
        the timeout expires with no change for that path.

        The kind is deliberately not checked here. Returning None for
        a kind mismatch too made the two outcomes indistinguishable to
        the caller, which rendered both as a timeout -- so a wrong-kind
        event delivered immediately was reported as a wait that never
        happened. The caller compares kinds on the change it gets back.

        Args:
            want_path (str): Virtual path the case expects.
        """
        deadline = asyncio.get_running_loop().time() + EVENT_TIMEOUT
        while True:
            self._arm()
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return None
            done, _ = await asyncio.wait({self._task}, timeout=remaining)
            if not done:
                return None
            change = self._task.result()
            self._task = None
            if change.path.virtual != want_path:
                continue
            return change

    async def absent(self, path: str) -> bool:
        """Assert no change for ``path`` arrives within the window.

        Unrelated changes (e.g. a parent-dir create) are drained and
        ignored; only a change for ``path`` itself fails the case.

        Args:
            path (str): Virtual path that must not be delivered.
        """
        deadline = asyncio.get_running_loop().time() + ABSENT_WINDOW
        while True:
            self._arm()
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return True
            done, _ = await asyncio.wait({self._task}, timeout=remaining)
            if not done:
                return True
            change = self._task.result()
            self._task = None
            if change.path.virtual == path:
                return False

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, StopAsyncIteration):
                pass
            self._task = None
        await self._agen.aclose()


class PingConsumer:
    """What a consumer runs when the service pings; mirage runs no loop.

    This is the whole pattern: on each ping, pull one delta from the
    VFS's hook, feed each change to ``ws.notify``, keep the checkpoint.
    The integ pumps it once per battery to lay down the baseline
    checkpoint, once more to take in the seed, then lets
    ``PingTrigger`` pump per case until that case's change is in the
    feed, as a provider's ping would arrive after each write.
    """

    def __init__(self, hook: DeltaHook, ws: Workspace, root: PathSpec) -> None:
        self._hook = hook
        self._ws = ws
        self._root = root
        self._checkpoint: str | None = None

    async def pump(
        self, timeout: float | None = None
    ) -> tuple[FileEvent, ...]:
        """Pull one delta, notify every change, and return them.

        Returning the changes (rather than nothing) is what lets a
        caller tell "nothing changed" from "the backend has not made
        the change visible yet". A production consumer ignores the
        return value and waits for the next ping.

        ``timeout`` caps the pull and nothing else, which is the whole
        point of putting it there. The pull is the only await before
        ``self._checkpoint`` moves, so abandoning it mutates nothing:
        the checkpoint still names the last delta that was notified in
        full, and the next pump re-reads the same ground. A cap on the
        body instead could land between the checkpoint assignment and
        the last ``notify``, and those changes would never be reported
        again -- the delta is computed against the new checkpoint, so
        no later pump rediscovers them. That is a lost event, the
        failure this consumer exists to catch, and it is not worth
        trading for a tidier bound. Only a deadline *we* imposed is
        reported as "no changes observed" rather than raised, because
        that is the same thing the caller does about it: pump again.
        A ``TimeoutError`` out of the backend client is re-raised,
        and telling the two apart is why this uses
        ``asyncio.timeout`` instead of the file's ``asyncio.wait_for``
        idiom: on the supported Pythons ``asyncio.TimeoutError`` *is*
        the builtin ``TimeoutError``, so the exception type alone
        cannot say whose clock fired, and only ``cm.expired()`` can.
        Catching both was silent data loss: a backend timeout during
        an uncapped baseline pump left ``_checkpoint`` at None, so the
        harness laid down no baseline, the first trigger pull was
        diffed as a fresh baseline (which by construction reports
        nothing), and that case's event was swallowed for good --
        exactly the swallowed exception CLAUDE.md forbids.

        The notify loop is left uncapped deliberately: it touches only
        process memory (cache eviction against the RAM index and file
        stores, then a push into each matching ``RAMEventQueue``), so
        it has no backend to hang on.

        Args:
            timeout (float | None): Seconds allowed for the backend
                listing. None waits for it indefinitely, which is what
                the baseline pumps want.

        Returns:
            tuple[FileEvent, ...]: The changes handed to ``notify``;
                empty when *our* deadline cut the listing short.

        Raises:
            TimeoutError: Propagated when the backend client raised it
                rather than our own deadline expiring.
        """
        if timeout is None:
            delta = await self._hook.pull(self._root, self._checkpoint)
        else:
            cap = asyncio.timeout(timeout)
            try:
                async with cap:
                    delta = await self._hook.pull(self._root, self._checkpoint)
            except TimeoutError:
                if not cap.expired():
                    raise
                return ()
        self._checkpoint = delta.checkpoint
        for change in delta.changes:
            await self._ws.notify(change)
        return delta.changes


DISK_EVENT_BY_KIND = {
    "create": "created",
    "update": "modified",
    "delete": "deleted",
    "move": "moved",
}


def _disk_notification(
    expect: dict, mount: str, host_root: str
) -> tuple[str, dict]:
    """Build the watchdog event a real filesystem watcher would emit.

    Field names are watchdog's own, so what the harness posts is byte
    for byte what a consumer forwards from ``FileSystemEvent``.

    Args:
        expect (dict): Case ``expect`` block ({"kind", "path", ...}).
        mount (str): Mirage mount root.
        host_root (str): The disk VFS's root on the host.
    """
    base = host_root.rstrip("/")
    rel = expect["path"][len(mount.rstrip("/")) :]
    if expect["kind"] == "move":
        prev = expect["previous"][len(mount.rstrip("/")) :]
        return "moved", {
            "src_path": base + prev,
            "dest_path": base + rel,
        }
    return DISK_EVENT_BY_KIND[expect["kind"]], {"src_path": base + rel}


def _framed(path: str) -> str:
    """Spell ``path`` the way ``EventStream`` compares it.

    Args:
        path (str): Virtual path as a delta or a case file spells it.
    """
    return "/" + path.strip("/")


def _miss_detail(
    want: str, observed: tuple[FileEvent, ...], pumps: int
) -> str:
    """Describe a pump phase that never saw ``want``.

    The line names both sides of the comparison that failed: the path
    the trigger waited for, and the paths the last delta that reported
    anything actually carried. Paths that are all unrelated to the
    case is visibility lag on that one object, and a path that differs
    from ``want`` only in its framing is the comparison asymmetry,
    which this reports and deliberately does not paper over --
    ``EventStream`` compares ``_framed`` paths while the trigger
    compares the raw ``virtual``, so a trailing or leading slash
    blinds the trigger to a change the stream would have matched.

    Args:
        want (str): Virtual path the case expects.
        observed (tuple[FileEvent, ...]): Last delta that reported
            any change; empty when no delta reported one.
        pumps (int): Pumps the phase issued.
    """
    head = (
        f"waited for {want!r} over {pumps} pump(s) in "
        f"{PUMP_WINDOW}s, last delta reported "
    )
    if not observed:
        return f"{head}no paths"
    paths = [change.path.virtual for change in observed]
    tail = f"{paths}"
    if any(_framed(path) == _framed(want) for path in paths):
        tail += " (framed match: raw comparison missed it)"
    return head + tail


class CaseTrigger:
    """The trigger protocol ``_run_case`` drives: fire this case's
    change signal, and answer for what it did when the case then
    fails. Only ping mode has anything to add."""

    def diagnostic(self) -> str:
        """Extra detail for a failing case, or "" when there is none."""
        return ""


class PingTrigger(CaseTrigger):
    """Case trigger for ping mode: answer the provider's ping by pumping
    the consumer until the case's change shows up in the feed.

    A single pump gives the case exactly one feed read, issued the
    instant the external write returns, so any write-visibility lag in
    the backend would lose that case's event. Re-pumping on a short
    interval rides the lag out, as a provider that pings again would.

    The re-pump phase is bounded by the wall clock, not by a number of
    attempts: ``PUMP_WINDOW`` is half of ``EVENT_TIMEOUT``, wide enough
    to ride out a backend that publishes a write a few seconds after
    acknowledging it, and strictly shorter than the wait an undelivered
    event has to fail on. Every pump is handed the time left, so a read
    that hangs is abandoned at the deadline; what is capped is the
    read, not ``pump`` as a whole, for the reason
    ``PingConsumer.pump`` gives.

    The loop waits for the case's own path instead of any change: a
    nested create also creates its parent directory, and a rename can
    be a DELETE plus a CREATE, so "some change appeared" can be true
    while the change the case asserts on is still invisible. Giving up
    is recorded rather than silent, because the case that follows
    fails on the stream timeout and that message says only that no
    event arrived.
    """

    def __init__(self, consumer: PingConsumer) -> None:
        """Args:
        consumer (PingConsumer): Pumped once per attempt.
        """
        self._consumer = consumer
        self._miss = ""

    def diagnostic(self) -> str:
        """What the last pump phase failed to see, or "" when it saw
        the case's path (or when no phase has run)."""
        return self._miss

    async def __call__(self, case: dict) -> None:
        want = case["expect"]["path"]
        loop = asyncio.get_running_loop()
        deadline = loop.time() + PUMP_WINDOW
        self._miss = ""
        observed: tuple[FileEvent, ...] = ()
        pumps = 0
        while True:
            remaining = deadline - loop.time()
            changes = await self._consumer.pump(timeout=max(remaining, 0.0))
            pumps += 1
            if changes:
                observed = changes
            if any(change.path.virtual == want for change in changes):
                return
            remaining = deadline - loop.time()
            if remaining <= 0:
                self._miss = _miss_detail(want, observed, pumps)
                return
            await asyncio.sleep(min(PUMP_INTERVAL, remaining))


class PushTrigger(CaseTrigger):
    """Case trigger for push mode: POST the webhook payload the case's
    mutation would have produced. Nothing pulls, so a delivered
    event can only have come from the webhook."""

    def __init__(
        self, session: aiohttp.ClientSession, url: str, mount: str
    ) -> None:
        self._session = session
        self._url = url
        self._mount = mount

    async def __call__(self, case: dict) -> None:
        payload = _webhook_payload(case["expect"], self._mount)
        async with self._session.post(self._url, json=payload) as resp:
            await resp.read()


class EventTrigger(CaseTrigger):
    """Case trigger for event mode: hand the backend its own service
    notification and notify whatever the event hook maps it to.

    Nothing pulls and no webhook exists, so a delivered change can only
    have come from ``to_events``."""

    def __init__(
        self,
        ws: Workspace,
        hook: DiskEventHook,
        root: PathSpec,
        mount: str,
        host_root: str,
    ) -> None:
        self._ws = ws
        self._hook = hook
        self._root = root
        self._mount = mount
        self._host_root = host_root

    async def __call__(self, case: dict) -> None:
        kind, payload = _disk_notification(
            case["expect"], self._mount, self._host_root
        )
        for change in await self._hook.to_events(self._root, kind, payload):
            await self._ws.notify(change)


async def _run_check(ws: Workspace, check: dict) -> tuple[bool, str]:
    """Run one post-event read and assert its output.

    Args:
        ws (Workspace): Subscribed workspace.
        check (dict): {"cmd", "contains"?|"absent"?}.
    """
    result = await ws.shell(check["cmd"])
    out = (await result.stdout_str()).strip()
    if "contains" in check:
        ok = check["contains"] in out
        return ok, f"{check['cmd']!r} contains {check['contains']!r}"
    ok = check["absent"] not in out
    return ok, f"{check['cmd']!r} absent {check['absent']!r}"


async def _run_case(
    ws: Workspace,
    op: ExternalWriter,
    trigger: CaseTrigger,
    stream: EventStream,
    case: dict,
) -> tuple[bool, str]:
    """Run one warm -> mutate -> trigger -> event -> checks case.

    ``warm`` reads populate mirage's cache BEFORE the external
    mutation, so the post-event checks prove invalidation of genuinely
    cached state, not just cold reads. The event fires only after
    invalidation, so checks (cat, head, ls, grep) must be fresh.

    Args:
        ws (Workspace): Subscribed workspace.
        op (ExternalWriter): External writer operator.
        trigger (CaseTrigger): Fires the change signal for this case
            (ping pump or push webhook POST) and, when the case then
            fails, says what it saw while doing so.
        stream (EventStream): Armed event consumer.
        case (dict): One case from the file.
    """
    want = case["expect"]
    for cmd in case.get("warm", []):
        await ws.shell(cmd)
    await _mutate(op, case["mutate"])
    await trigger(case)
    if want.get("delivered", True):
        change = await stream.expect(want["path"])
        if change is None:
            detail = f"no change for {want['path']} within {EVENT_TIMEOUT}s"
            hint = trigger.diagnostic()
            return False, f"{detail}; {hint}" if hint else detail
        if change.kind.value != want["kind"]:
            return False, (
                f"{want['path']} delivered as "
                f"{change.kind.value}, expected {want['kind']}"
            )
    else:
        if not await stream.absent(want["path"]):
            return False, f"unexpected delivery for {want['path']}"
    for check in case.get("checks", []):
        ok, detail = await _run_check(ws, check)
        if not ok:
            return False, f"check failed: {detail}"
    verdict = "delivered" if want.get("delivered", True) else "skipped"
    checks = len(case.get("checks", []))
    return True, f"{want['kind']} {verdict} + {checks} checks"


async def _seed(ws: Workspace, op: ExternalWriter, spec: dict) -> None:
    """Reset the root and lay down the seed files.

    Both halves of the reset are load-bearing. The external writer
    empties the directory, because a mount that is a read view of its
    backend cannot ``rm -rf`` its own root (github's is one: a ref
    changes by being committed to), and a battery whose reset silently
    did nothing carries one scope's files into the next, where their
    CREATEs arrive as UPDATEs. The subscribed workspace then runs its own
    ``rm -rf``, which is what drops the listing it had cached.

    Args:
        ws (Workspace): Subscribed workspace.
        op (ExternalWriter): External writer operator.
        spec (dict): Parsed case file.
    """
    root = _root_rel(spec) + "/"
    await op.create_dir(root)
    await op.remove_all(root)
    await ws.shell(f"rm -rf {spec['root']}")
    await ws.shell(f"mkdir -p {spec['root']}")
    for name in spec["seed"]:
        await op.write(f"data/{name}", b"seed")


async def _run_battery(
    ws: Workspace,
    op: ExternalWriter,
    trigger: CaseTrigger,
    agen: AsyncGenerator[FileEvent, None],
    cases: list[dict],
    label: str,
    mode: str,
    vfs: str,
) -> list[tuple[str, bool, str]]:
    """Run one battery of cases against one armed events iterator.

    Args:
        ws (Workspace): Subscribed workspace.
        op (ExternalWriter): External writer operator.
        trigger (CaseTrigger): Case trigger (ping pump or push POST).
        agen (AsyncGenerator[FileEvent, None]): The ``events``
            async iterator for this battery.
        cases (list[dict]): Cases to run in order; a case with a
            ``modes`` list runs only in those modes, and one with a
            ``skip_vfs`` list runs on every backend but those (a rename
            is a MOVE on Box, whose events name the item's old place,
            and a DELETE + CREATE on a feed that names only the new one).
            The default is every mode: a per-case list is how a case
            opts *out*, so defaulting to a subset would silently skip
            every case of any mode added later, which is how the first
            event battery ran zero cases and still reported OK.
        label (str): Result-line prefix (mode and scope).
        mode (str): "ping", "push" or "event".
        vfs (str): The backend the battery runs on.
    """
    stream = EventStream(agen)
    await stream.start()
    results: list[tuple[str, bool, str]] = []
    try:
        for case in cases:
            if mode not in case.get("modes", ALL_MODES):
                continue
            if vfs in case.get("skip_vfs", []):
                continue
            ok, detail = await _run_case(ws, op, trigger, stream, case)
            results.append((f"{label}:{case['id']}", ok, detail))
    finally:
        await stream.close()
    return results


async def _overflow_core(
    spec: dict,
    ws: Workspace,
    op: ExternalWriter,
    trigger,
    mode: str,
    results: list,
) -> None:
    """Shared body of the overflow battery: many changes against a
    tiny queue must collapse into one UNKNOWN event at the event root.

    The stream is armed once (consuming exactly one event); later
    events accumulate with no active pop, so the cap trips
    deterministically.

    Args:
        spec (dict): Parsed case file (needs an ``overflow`` block).
        ws (Workspace): Overflow-dedicated workspace (tiny queue).
        op (ExternalWriter): External writer operator.
        trigger (Callable): Case trigger (ping pump or push POST).
        mode (str): "ping" or "push".
        results (list): Result rows to append to.
    """
    block = spec["overflow"]
    agen = ws.events(spec["root"])
    stream = EventStream(agen)
    await stream.start()
    try:
        for path in block["paths"]:
            await _mutate(op, {"op": "write", "path": path, "body": "burst\n"})
            await trigger(
                {
                    "expect": {
                        "kind": "create",
                        "path": spec["mount"] + "/" + path,
                    }
                }
            )
        change = await stream.expect(spec["root"])
        if change is None:
            results.append(
                (
                    f"{mode}:overflow:collapse",
                    False,
                    f"no event at event root within {EVENT_TIMEOUT}s",
                )
            )
            return
        if change.kind.value != "unknown":
            results.append(
                (
                    f"{mode}:overflow:collapse",
                    False,
                    f"{spec['root']} delivered as "
                    f"{change.kind.value}, expected unknown",
                )
            )
            return
        ok = True
        detail = "unknown collapse + fresh reads"
        for check in block.get("checks", []):
            check_ok, check_detail = await _run_check(ws, check)
            if not check_ok:
                ok, detail = False, f"check failed: {check_detail}"
                break
        results.append((f"{mode}:overflow:collapse", ok, detail))
    finally:
        await stream.close()


async def _overflow_workspace(spec: dict) -> tuple[Workspace, ExternalWriter]:
    """Build the overflow battery's own workspace with a tiny queue.

    A dedicated workspace is required because the custom queue factory
    must attach via ``attach_event_runtime`` before the first ``events``.

    Args:
        spec (dict): Parsed case file.
    """
    ws, op = await BUILDERS[spec["vfs"]](spec)
    ws.attach_event_runtime(
        EventHub(
            ws.registry,
            queue_factory=partial(
                RAMEventQueue, max_pending=spec["overflow"]["max_pending"]
            ),
        )
    )
    return ws, op


async def _run_overflow_ping(spec: dict, results: list) -> None:
    """Overflow battery, ping mode.

    Args:
        spec (dict): Parsed case file.
        results (list): Result rows to append to.
    """
    if "overflow" not in spec:
        return
    ws, op = await _overflow_workspace(spec)
    try:
        consumer = await _baseline(ws, op, spec)
        await _overflow_core(
            spec, ws, op, PingTrigger(consumer), "ping", results
        )
    finally:
        await ws.close()


async def _run_overflow_push(spec: dict, results: list) -> None:
    """Overflow battery, push mode (its own receiver bound to the
    overflow workspace).

    Args:
        spec (dict): Parsed case file.
        results (list): Result rows to append to.
    """
    if "overflow" not in spec:
        return
    ws, op = await _overflow_workspace(spec)
    try:
        await _seed(ws, op, spec)
        runner = web.AppRunner(make_app(ws, spec["mount"]))
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        url = f"http://127.0.0.1:{port}/nextcloud/webhook"
        async with aiohttp.ClientSession() as session:
            try:
                await _overflow_core(
                    spec,
                    ws,
                    op,
                    PushTrigger(session, url, spec["mount"]),
                    "push",
                    results,
                )
            finally:
                await runner.cleanup()
    finally:
        await ws.close()


async def _seed_nested(op: ExternalWriter, block: dict) -> None:
    """Reset the nested battery's subtree and lay down its seeds.

    Seeding goes through the external writer only: the battery's
    workspaces are fresh, so there is no cache to reset, and ``rm -rf``
    from inside would have to cross the nested mount boundary.

    Args:
        op (ExternalWriter): External writer operator (outer
            account root).
        block (dict): The ``nested`` block of the case file.
    """
    root = block["root"].strip("/") + "/"
    await op.create_dir(root)
    await op.remove_all(root)
    await op.create_dir(block["inner_root"].strip("/") + "/")
    for rel, body in block["seed"].items():
        await op.write(rel, body.encode())


async def _nested_core(
    spec: dict,
    ws: Workspace,
    op: ExternalWriter,
    trigger: CaseTrigger,
    mode: str,
    results: list,
) -> None:
    """Shared body of the nested-mount battery: one subscription on the shared
    ancestor spans both mounts, and each event must invalidate the
    mount that owns its path (longest prefix), so post-event reads
    through the inner mount are fresh.

    Args:
        spec (dict): Parsed case file (needs a ``nested`` block).
        ws (Workspace): Nested-mount workspace.
        op (ExternalWriter): External writer operator.
        trigger (CaseTrigger): Case trigger (a push POST).
        mode (str): The mode label, "push".
        results (list): Result rows to append to.
    """
    block = spec["nested"]
    agen = ws.events(block["subscribe"])
    stream = EventStream(agen)
    await stream.start()
    try:
        for case in block["cases"]:
            ok, detail = await _run_case(ws, op, trigger, stream, case)
            results.append((f"{mode}:nested:{case['id']}", ok, detail))
    finally:
        await stream.close()


async def _run_nested_push(spec: dict, results: list) -> None:
    """Nested-mount battery, push mode (its own receiver bound to the
    nested workspace; payload paths are mapped against the outer mount
    and reframed to the inner mount by ``notify``).

    Args:
        spec (dict): Parsed case file.
        results (list): Result rows to append to.
    """
    if "nested" not in spec:
        return
    built = await _build_nextcloud_nested(spec)
    if built is None:
        return
    ws, op = built
    try:
        await _seed_nested(op, spec["nested"])
        runner = web.AppRunner(make_app(ws, spec["mount"]))
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        url = f"http://127.0.0.1:{port}/nextcloud/webhook"
        async with aiohttp.ClientSession() as session:
            try:
                await _nested_core(
                    spec,
                    ws,
                    op,
                    PushTrigger(session, url, spec["mount"]),
                    "push",
                    results,
                )
            finally:
                await runner.cleanup()
    finally:
        await ws.close()


async def _baseline(
    ws: Workspace, op: ExternalWriter, spec: dict
) -> PingConsumer:
    """Lay down the baseline checkpoint, then the seed, and take the
    seed in, before any subscription is armed.

    A ping handler names an item it has never seen as made since the
    last read or not by what the service says, and some services
    (Dropbox, Box) say nothing, so the seed is written after the
    baseline and read once: every seeded file is then one the hook has
    seen, and a case that rewrites it is an UPDATE on every backend.

    Args:
        ws (Workspace): Subscribed workspace.
        op (ExternalWriter): External writer operator.
        spec (dict): Parsed case file.
    """
    vfs = ws.registry.mount_for(spec["mount"]).vfs
    consumer = PingConsumer(vfs.delta_hook(), ws, _framed_root(spec))
    await consumer.pump()
    await _seed(ws, op, spec)
    await consumer.pump()
    return consumer


async def _run_ping(
    spec: dict, ws: Workspace, op: ExternalWriter
) -> list[tuple[str, bool, str]]:
    """Run all batteries in ping mode (the provider pings, the consumer
    pulls once).

    The consumer always reads the whole root; scope filtering
    (folder, glob pattern, single file) happens in the hub at
    delivery time, which is exactly the production shape.

    Args:
        spec (dict): Parsed case file.
        ws (Workspace): Subscribed workspace.
        op (ExternalWriter): External writer operator.
    """
    results: list[tuple[str, bool, str]] = []
    consumer = await _baseline(ws, op, spec)
    agen = ws.events(spec["root"])
    results.extend(
        await _run_battery(
            ws,
            op,
            PingTrigger(consumer),
            agen,
            spec["cases"],
            "ping",
            "ping",
            spec["vfs"],
        )
    )
    for scope in spec.get("scopes", []):
        if spec["vfs"] in scope.get("skip_vfs", []):
            continue
        consumer = await _baseline(ws, op, spec)
        agen = ws.events(scope["subscribe"])
        results.extend(
            await _run_battery(
                ws,
                op,
                PingTrigger(consumer),
                agen,
                scope["cases"],
                f"ping:{scope['id']}",
                "ping",
                spec["vfs"],
            )
        )
    await _run_overflow_ping(spec, results)
    return results


async def _run_event(
    spec: dict, ws: Workspace, op: ExternalWriter
) -> list[tuple[str, bool, str]]:
    """Run all batteries in event mode (raw notification -> hook -> notify).

    Args:
        spec (dict): Parsed case file.
        ws (Workspace): Subscribed workspace.
        op (ExternalWriter): External writer operator.
    """
    # The battery names the backend rather than asking the mount for a
    # hook: the payload it has to build is watchdog's, so the call site
    # is disk-specific either way. Push has no vendor-neutral shape, so
    # a generic accessor would buy nothing here.
    vfs = ws.registry.mount_for(spec["mount"]).vfs
    hook = DiskEventHook(vfs.accessor)
    host_root = str(vfs.accessor.root)
    trigger = EventTrigger(
        ws, hook, _framed_root(spec), spec["mount"], host_root
    )
    results: list[tuple[str, bool, str]] = []

    await _seed(ws, op, spec)
    agen = ws.events(spec["root"])
    results.extend(
        await _run_battery(
            ws, op, trigger, agen, spec["cases"], "event", "event", spec["vfs"]
        )
    )

    for scope in spec.get("scopes", []):
        if spec["vfs"] in scope.get("skip_vfs", []):
            continue
        await _seed(ws, op, spec)
        agen = ws.events(scope["subscribe"])
        results.extend(
            await _run_battery(
                ws,
                op,
                trigger,
                agen,
                scope["cases"],
                f"event:{scope['id']}",
                "event",
                spec["vfs"],
            )
        )
    return results


async def _run_push(
    spec: dict, ws: Workspace, op: ExternalWriter
) -> list[tuple[str, bool, str]]:
    """Run all batteries in push mode (webhook -> notify).

    Starts the sample webhook receiver a consumer would host, POSTs the
    Nextcloud payload each case implies, and relies on ``notify`` for
    delivery. Nothing pulls at all, so a delivered event can only have
    come from the webhook; scope filtering happens in the hub
    exactly as in ping mode.

    Args:
        spec (dict): Parsed case file.
        ws (Workspace): Subscribed workspace.
        op (ExternalWriter): External writer operator.
    """
    runner = web.AppRunner(make_app(ws, spec["mount"]))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    url = f"http://127.0.0.1:{port}/nextcloud/webhook"

    results: list[tuple[str, bool, str]] = []
    async with aiohttp.ClientSession() as session:
        trigger = PushTrigger(session, url, spec["mount"])
        try:
            await _seed(ws, op, spec)
            agen = ws.events(spec["root"])
            results.extend(
                await _run_battery(
                    ws,
                    op,
                    trigger,
                    agen,
                    spec["cases"],
                    "push",
                    "push",
                    spec["vfs"],
                )
            )
            for scope in spec.get("scopes", []):
                await _seed(ws, op, spec)
                agen = ws.events(scope["subscribe"])
                results.extend(
                    await _run_battery(
                        ws,
                        op,
                        trigger,
                        agen,
                        scope["cases"],
                        f"push:{scope['id']}",
                        "push",
                        spec["vfs"],
                    )
                )
        finally:
            await runner.cleanup()
    await _run_overflow_push(spec, results)
    await _run_nested_push(spec, results)
    return results


async def _run_file(spec: dict) -> list[tuple[str, bool, str]]:
    """Run one case file in each mode it declares.

    Args:
        spec (dict): Parsed case file.
    """
    builder = BUILDERS.get(spec["vfs"])
    if builder is None:
        return [(spec["vfs"], False, "no builder")]
    modes = {"ping": _run_ping, "push": _run_push, "event": _run_event}
    wanted = spec["modes"]
    results: list[tuple[str, bool, str]] = []
    for name in wanted:
        built = await builder(spec)
        if built is None:
            print(
                f"skip [{spec['vfs']}]: deployment env absent", file=sys.stderr
            )
            return []
        ws, op = built
        try:
            results.extend(await modes[name](spec, ws, op))
        finally:
            await ws.close()
            closer = getattr(op, "close", None)
            if closer is not None:
                await closer()
    return results


def _expand(spec: dict) -> list[dict]:
    """Fan one case file out over the mounts it names.

    A file that declares ``mounts`` runs its whole body once per
    backend, so the shared batteries are written down once rather than
    copied per target.

    Args:
        spec (dict): Parsed case file.
    """
    names = spec.get("mounts")
    if not names:
        return [spec]
    return [{**spec, "vfs": name} for name in names]


class StepSummary:
    """Mirror the failing result lines into the job's step summary.

    stdout is the only place this battery reports, and a hosted
    runner's raw step log is not always reachable afterwards (an org
    egress policy can block the blob host the Actions API hands out
    for it), which leaves a red job whose check output says nothing
    but the exit code. ``$GITHUB_STEP_SUMMARY`` renders every FAIL
    line on the job page, so a human who can open the run reads the
    failing case without opening the step log.

    That is the whole of what it buys, and the limit matters:
    a step summary is **not** retrievable through the API. On a
    completed failing job the REST check-run's ``output.title``,
    ``output.summary`` and ``output.text`` are all null, its sole
    annotation is ``Process completed with exit code 1.``, and the
    job's HTML page answers 403 to a token. So a reader who only has
    the API sees nothing here, which is why ``ResultsFile`` persists
    the same content as an uploaded artifact -- artifacts the API
    does serve.

    Only failures are written, and the file is appended line by line
    rather than once at the end, so a run the step timeout kills
    still names the cases it had already failed. Outside Actions the
    variable is unset and every call is a no-op.
    """

    def __init__(self) -> None:
        value = os.environ.get("GITHUB_STEP_SUMMARY")
        self._path = Path(value) if value else None
        self._headed = False

    def add(self, line: str) -> None:
        """Append one failing result line.

        Args:
            line (str): The FAIL line exactly as stdout carries it.
        """
        if self._path is None:
            return
        with self._path.open("a", encoding="utf-8") as fh:
            if not self._headed:
                fh.write("## Event battery failures\n\n")
                self._headed = True
            fh.write(f"- `{line}`\n")


class ResultsFile:
    """Persist the result transcript to a file on disk.

    This is the channel a reader outside the runner actually gets.
    The step summary renders for a human on the job page and stops
    there, and the raw step log is behind a blob host an org egress
    policy can block; an artifact is served by the REST API, so the
    workflow uploads this file with ``if: always()`` and the failing
    case's name survives the job.

    PASS lines are written too, because the list of cases that ran
    is itself diagnostic: a battery that fell over before it reached
    a backend and one whose every case passed both leave an empty
    failure list, and only the transcript tells them apart.

    The file is truncated on construction rather than on first write,
    so it exists even for a run that reports no lines at all -- an
    upload that silently finds nothing is the same hole this is
    closing. Lines are appended as they are printed, so a run the
    step timeout kills keeps what it had already reported.
    ``EVENTS_RESULTS_FILE`` overrides the path.
    """

    def __init__(self) -> None:
        value = os.environ.get("EVENTS_RESULTS_FILE")
        self._path = Path(value) if value else DEFAULT_RESULTS_FILE
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text("", encoding="utf-8")

    @property
    def path(self) -> Path:
        """Where the transcript is being written."""
        return self._path

    def add(self, line: str) -> None:
        """Append one result line.

        Args:
            line (str): The PASS or FAIL line exactly as stdout
                carries it.
        """
        with self._path.open("a", encoding="utf-8") as fh:
            fh.write(f"{line}\n")


def _escape_annotation(message: str) -> str:
    """Percent-encode one line for an Actions workflow command.

    Args:
        message (str): The line as stdout carries it.

    Returns:
        str: The line with ``%``, CR and LF encoded, in the order the
            runner's own escaping applies them -- ``%`` first, so the
            escapes it writes are not re-escaped.
    """
    return (
        message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    )


class Annotations:
    """Emit each failing result line as an Actions error annotation.

    This is the failure channel a reader holding only the REST API
    can actually read. A step summary is not served by the API at
    all, and the raw step log and an artifact's *content* both
    redirect to a blob host an org egress policy can block, which
    leaves the artifact listed and undownloadable. Check-run
    annotations are served
    (``GET /repos/{owner}/{repo}/check-runs/{id}/annotations``), so a
    line emitted here survives for a reader who can open nothing else
    about the run.

    Without it the only annotation on a red job is the runner's own
    ``Process completed with exit code 1.``, which names neither the
    failing case nor the want-vs-observed detail its FAIL line
    carries.

    Only failures are annotated, and each is printed as it is
    reported rather than batched at the end, so a run the step
    timeout kills still annotates the cases it had already failed.
    Outside Actions ``GITHUB_ACTIONS`` is unset and every call is a
    no-op, so a local run's stdout is unchanged.
    """

    def __init__(self) -> None:
        self._active = os.environ.get("GITHUB_ACTIONS") == "true"

    def add(self, line: str) -> None:
        """Emit one failing result line as an error annotation.

        Args:
            line (str): The FAIL line exactly as stdout carries it.
        """
        if not self._active:
            return
        print(f"::error title=Event case failed::{_escape_annotation(line)}")


async def main() -> None:
    files = sorted(p for p in CASE_DIR.glob("*.json"))
    summary = StepSummary()
    annotations = Annotations()
    results = ResultsFile()
    print(f"event battery results: {results.path}")
    failed = 0
    for path in files:
        for spec in _expand(json.loads(path.read_text())):
            for case_id, ok, detail in await _run_file(spec):
                status = "PASS" if ok else "FAIL"
                line = f"{status} [{spec['vfs']}] {case_id}: {detail}"
                print(line)
                results.add(line)
                if not ok:
                    failed += 1
                    summary.add(line)
                    annotations.add(line)
    if failed:
        verdict = f"FAIL: {failed} event case(s) failed"
        results.add(verdict)
        print(verdict, file=sys.stderr)
        sys.exit(1)
    verdict = "OK: all event cases passed"
    results.add(verdict)
    print(verdict)


if __name__ == "__main__":
    asyncio.run(main())
