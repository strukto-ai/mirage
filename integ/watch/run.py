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
from pathlib import Path

import aiohttp
from aiohttp import web
from webhook_server import make_app

from mirage import MountMode, Workspace
from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.resource.nextcloud import NextcloudConfig, NextcloudResource
from mirage.types import PathSpec
from mirage.watch import Watcher, enable_watch

CASE_DIR = Path(__file__).resolve().parent
EVENT_TIMEOUT = 20.0
ABSENT_WINDOW = 1.0
CLASS_BY_KIND = {
    "create": "OCP\\Files\\Events\\Node\\NodeCreatedEvent",
    "update": "OCP\\Files\\Events\\Node\\NodeWrittenEvent",
    "delete": "OCP\\Files\\Events\\Node\\NodeDeletedEvent",
}


def _build_nextcloud(spec: dict) -> tuple[Workspace, object] | None:
    """Build the watched workspace and a separate external writer.

    Returns None when the deployment env is absent, so a local run
    without a Nextcloud server skips instead of failing.

    Args:
        spec (dict): Parsed case file.
    """
    url = os.environ.get("NEXTCLOUD_URL")
    if not url:
        return None
    config = NextcloudConfig(
        url=url,
        username=os.environ.get("NEXTCLOUD_USERNAME", "admin"),
        password=os.environ.get("NEXTCLOUD_PASSWORD", "admin123"),
    )
    ws = Workspace({spec["mount"]: NextcloudResource(config)},
                   mode=MountMode.WRITE)
    external = NextcloudAccessor(config).operator()
    return ws, external


BUILDERS = {"nextcloud": _build_nextcloud}


def _files_prefix() -> str:
    """The ``/<user>/files`` prefix Nextcloud puts in webhook paths."""
    return f"/{os.environ.get('NEXTCLOUD_USERNAME', 'admin')}/files"


def _framed_root(spec: dict) -> PathSpec:
    """Build the mount-framed watch_dir root the delta hook pulls over.

    Args:
        spec (dict): Parsed case file.
    """
    rel = spec["watch_dir"][len(spec["mount"].rstrip("/")):].strip("/")
    return PathSpec.from_str_path(spec["watch_dir"], resource_path=rel)


async def _mutate(op: object, mutate: dict) -> None:
    """Apply one mutation directly to the backend, bypassing the
    watched workspace so its cache is genuinely stale.

    Args:
        op (object): opendal operator of a separate accessor.
        mutate (dict): {"op", "path", "body"?}.
    """
    if mutate["op"] == "write":
        parent = mutate["path"].rsplit("/", 1)[0]
        if parent:
            await op.create_dir(parent + "/")
        await op.write(mutate["path"], mutate["body"].encode())
    elif mutate["op"] == "delete":
        await op.delete(mutate["path"])
    else:
        raise ValueError(f"unknown mutate op: {mutate['op']}")


def _webhook_payload(expect: dict, mount: str) -> dict:
    """Build the Nextcloud payload a real webhook_listeners would send.

    Args:
        expect (dict): Case ``expect`` block ({"kind", "path"}).
        mount (str): Mirage mount root.
    """
    rel = expect["path"][len(mount.rstrip("/")):]
    node_path = _files_prefix() + rel
    return {
        "event": {
            "class": CLASS_BY_KIND[expect["kind"]],
            "node": {
                "id": 1,
                "path": node_path
            },
        },
        "time": 1700000000,
    }


class EventStream:
    """Consume a watch iterator with an always-armed pending task.

    Arming before any mutation matters: an async generator body (which
    registers the subscriber) only runs on the first ``__anext__``, so
    consuming lazily would lose events notified before the first await.
    """

    def __init__(self, agen: object) -> None:
        self._agen = agen
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        """Arm the iterator and yield to the loop so the subscriber
        registers before the first mutation."""
        self._arm()
        await asyncio.sleep(0.05)

    def _arm(self) -> None:
        if self._task is None:
            self._task = asyncio.ensure_future(self._agen.__anext__())

    async def expect(self, want_path: str, want_kind: str) -> object | None:
        """Return the next change for ``want_path``, skipping others
        (a nested create also emits its parent dir), or None on
        timeout or kind mismatch.

        Args:
            want_path (str): Virtual path the case expects.
            want_kind (str): ChangeKind value the case expects.
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
            if change.kind.value != want_kind:
                return None
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


class ConsumerPoller:
    """The poll loop a consumer runs; mirage runs no loop itself.

    This is the whole pattern: pull a delta from the resource's hook,
    feed each change to ``watcher.notify``, keep the checkpoint. In
    production this body runs on an interval (or after a webhook
    doorbell); the integ pumps it once per case for determinism.
    """

    def __init__(self, hook: object, watcher: Watcher, root: PathSpec) -> None:
        self._hook = hook
        self._watcher = watcher
        self._root = root
        self._checkpoint: str | None = None

    async def pump(self) -> None:
        delta = await self._hook.pull(self._root, self._checkpoint)
        self._checkpoint = delta.checkpoint
        for change in delta.changes:
            await self._watcher.notify(change)


class PullTrigger:
    """Case trigger for pull mode: pump the consumer's poller once."""

    def __init__(self, poller: ConsumerPoller) -> None:
        self._poller = poller

    async def __call__(self, case: dict) -> None:
        await self._poller.pump()


class PushTrigger:
    """Case trigger for push mode: POST the webhook payload the case's
    mutation would have produced. No poller exists, so a delivered
    event can only have come from the webhook."""

    def __init__(self, session: aiohttp.ClientSession, url: str,
                 mount: str) -> None:
        self._session = session
        self._url = url
        self._mount = mount

    async def __call__(self, case: dict) -> None:
        payload = _webhook_payload(case["expect"], self._mount)
        async with self._session.post(self._url, json=payload) as resp:
            await resp.read()


async def _run_check(ws: Workspace, check: dict) -> tuple[bool, str]:
    """Run one post-event read and assert its output.

    Args:
        ws (Workspace): Watched workspace.
        check (dict): {"cmd", "contains"?|"absent"?}.
    """
    result = await ws.execute(check["cmd"])
    out = (await result.stdout_str()).strip()
    if "contains" in check:
        ok = check["contains"] in out
        return ok, f"{check['cmd']!r} contains {check['contains']!r}"
    ok = check["absent"] not in out
    return ok, f"{check['cmd']!r} absent {check['absent']!r}"


async def _run_case(ws: Workspace, op: object, trigger, stream: EventStream,
                    case: dict) -> tuple[bool, str]:
    """Run one warm -> mutate -> trigger -> event -> checks case.

    ``warm`` reads populate mirage's cache BEFORE the external
    mutation, so the post-event checks prove invalidation of genuinely
    cached state, not just cold reads. The event fires only after
    invalidation, so checks (cat, head, ls, grep) must be fresh.

    Args:
        ws (Workspace): Watched workspace.
        op (object): External writer operator.
        trigger (Callable): Awaitable firing the change signal for
            this case (pull pump or push webhook POST).
        stream (EventStream): Armed watch consumer.
        case (dict): One case from the file.
    """
    want = case["expect"]
    for cmd in case.get("warm", []):
        await ws.execute(cmd)
    await _mutate(op, case["mutate"])
    await trigger(case)
    if want.get("delivered", True):
        change = await stream.expect(want["path"], want["kind"])
        if change is None:
            return False, (f"no {want['kind']} for {want['path']} within "
                           f"{EVENT_TIMEOUT}s")
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


async def _seed(ws: Workspace, op: object, spec: dict) -> None:
    """Reset the watch dir and lay down the seed files.

    Args:
        ws (Workspace): Watched workspace.
        op (object): External writer operator.
        spec (dict): Parsed case file.
    """
    await ws.execute(f"rm -rf {spec['watch_dir']}")
    await ws.execute(f"mkdir -p {spec['watch_dir']}")
    for name in spec["seed"]:
        await op.write(f"data/{name}", b"seed")


async def _run_battery(ws: Workspace, op: object, trigger, agen: object,
                       cases: list[dict],
                       label: str) -> list[tuple[str, bool, str]]:
    """Run one battery of cases against one armed watch iterator.

    Args:
        ws (Workspace): Watched workspace.
        op (object): External writer operator.
        trigger (Callable): Case trigger (pull pump or push POST).
        agen (object): The ``watch`` async iterator for this battery.
        cases (list[dict]): Cases to run in order.
        label (str): Result-line prefix (mode and scope).
    """
    stream = EventStream(agen)
    await stream.start()
    results: list[tuple[str, bool, str]] = []
    try:
        for case in cases:
            ok, detail = await _run_case(ws, op, trigger, stream, case)
            results.append((f"{label}:{case['id']}", ok, detail))
    finally:
        await stream.close()
    return results


async def _run_pull(spec: dict, ws: Workspace,
                    op: object) -> list[tuple[str, bool, str]]:
    """Run all batteries in pull mode (consumer-owned poll loop).

    The poller always pulls the full watch_dir; scope filtering
    (folder, glob pattern, single file) happens in the watcher at
    delivery time, which is exactly the production shape.

    Args:
        spec (dict): Parsed case file.
        ws (Workspace): Watched workspace.
        op (object): External writer operator.
    """
    watcher = enable_watch(ws)
    resource = ws.registry.mount_for(spec["mount"]).resource
    hook_root = _framed_root(spec)
    results: list[tuple[str, bool, str]] = []

    await _seed(ws, op, spec)
    agen = ws.watch(PathSpec.from_str_path(spec["watch_dir"]))
    poller = ConsumerPoller(resource.delta_hook(), watcher, hook_root)
    await poller.pump()
    results.extend(await _run_battery(ws, op, PullTrigger(poller), agen,
                                      spec["cases"], "pull"))

    for scope in spec.get("scopes", []):
        await _seed(ws, op, spec)
        roots = [PathSpec.from_str_path(v) for v in scope["watch"]]
        agen = ws.watch(roots)
        poller = ConsumerPoller(resource.delta_hook(), watcher, hook_root)
        await poller.pump()
        results.extend(await
                       _run_battery(ws, op, PullTrigger(poller), agen,
                                    scope["cases"], f"pull:{scope['id']}"))
    return results


async def _run_push(spec: dict, ws: Workspace,
                    op: object) -> list[tuple[str, bool, str]]:
    """Run all batteries in push mode (webhook -> notify).

    Starts the sample webhook receiver a consumer would host, POSTs the
    Nextcloud payload each case implies, and relies on ``notify`` for
    delivery. No poller exists at all, so a delivered event can only
    have come from the webhook; scope filtering happens in the watcher
    exactly as in pull mode.

    Args:
        spec (dict): Parsed case file.
        ws (Workspace): Watched workspace.
        op (object): External writer operator.
    """
    watcher = enable_watch(ws)
    runner = web.AppRunner(make_app(watcher, _files_prefix(), spec["mount"]))
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
            agen = ws.watch(PathSpec.from_str_path(spec["watch_dir"]))
            results.extend(await _run_battery(ws, op, trigger, agen,
                                              spec["cases"], "push"))
            for scope in spec.get("scopes", []):
                await _seed(ws, op, spec)
                roots = [PathSpec.from_str_path(v) for v in scope["watch"]]
                agen = ws.watch(roots)
                results.extend(await _run_battery(ws, op, trigger, agen,
                                                  scope["cases"],
                                                  f"push:{scope['id']}"))
        finally:
            await runner.cleanup()
    return results


async def _run_file(spec: dict) -> list[tuple[str, bool, str]]:
    """Run one case file in both pull and push mode.

    Args:
        spec (dict): Parsed case file.
    """
    builder = BUILDERS.get(spec["resource"])
    if builder is None:
        return [(spec["resource"], False, "no builder")]
    results: list[tuple[str, bool, str]] = []
    for mode in (_run_pull, _run_push):
        built = builder(spec)
        if built is None:
            print(f"skip [{spec['resource']}]: deployment env absent",
                  file=sys.stderr)
            return []
        ws, op = built
        try:
            results.extend(await mode(spec, ws, op))
        finally:
            await ws.close()
    return results


async def main() -> None:
    files = sorted(p for p in CASE_DIR.glob("*.json"))
    failed = 0
    for path in files:
        spec = json.loads(path.read_text())
        for case_id, ok, detail in await _run_file(spec):
            status = "PASS" if ok else "FAIL"
            print(f"{status} [{spec['resource']}] {case_id}: {detail}")
            if not ok:
                failed += 1
    if failed:
        print(f"FAIL: {failed} watch case(s) failed", file=sys.stderr)
        sys.exit(1)
    print("OK: all watch cases passed")


if __name__ == "__main__":
    asyncio.run(main())
