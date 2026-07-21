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
from mirage.watch import enable_watch

CASE_DIR = Path(__file__).resolve().parent
EVENT_TIMEOUT = 20.0
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


async def _mutate(op: object, mutate: dict) -> None:
    """Apply one mutation directly to the backend, bypassing the
    watched workspace so its cache is genuinely stale.

    Args:
        op (object): opendal operator of a separate accessor.
        mutate (dict): {"op", "path", "body"?}.
    """
    if mutate["op"] == "write":
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


async def _await_event(agen: object, want_path: str) -> object:
    """Return the next change for ``want_path``, skipping others.

    Args:
        agen (object): The ``watch`` async iterator.
        want_path (str): Virtual path the case expects.
    """

    async def _next_matching() -> object:
        while True:
            change = await agen.__anext__()
            if change.path.virtual == want_path:
                return change

    return await asyncio.wait_for(_next_matching(), timeout=EVENT_TIMEOUT)


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


async def _run_case(ws: Workspace, op: object, trigger, agen: object,
                    case: dict) -> tuple[bool, str]:
    """Run one mutate -> trigger -> event -> checks case.

    The event fires only after cache invalidation, so the checks (cat,
    head, ls, grep) prove the reads are fresh, not stale.

    Args:
        ws (Workspace): Watched workspace.
        op (object): External writer operator.
        trigger (Callable): Awaitable that fires the change signal for
            this case (pull nudge or push webhook POST).
        agen (object): The ``watch`` async iterator.
        case (dict): One case from the file.
    """
    want = case["expect"]
    await _mutate(op, case["mutate"])
    await trigger(case)
    try:
        change = await _await_event(agen, want["path"])
    except TimeoutError:
        return False, f"no event for {want['path']} within {EVENT_TIMEOUT}s"
    if change.kind.value != want["kind"]:
        return False, f"kind {change.kind.value} != {want['kind']}"
    for check in case["checks"]:
        ok, detail = await _run_check(ws, check)
        if not ok:
            return False, f"check failed: {detail}"
    return True, f"{want['kind']} + {len(case['checks'])} checks"


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


class ConsumerPoller:
    """The poll loop a consumer runs; mirage runs no loop itself.

    This is the whole pattern: pull a delta from the resource's hook,
    feed each change to ``watcher.notify``, keep the checkpoint. In
    production this body runs on an interval (or after a webhook
    doorbell); the integ pumps it once per case for determinism.
    """

    def __init__(self, hook: object, watcher: object, root: PathSpec) -> None:
        self._hook = hook
        self._watcher = watcher
        self._root = root
        self._checkpoint: str | None = None

    async def pump(self) -> None:
        delta = await self._hook.pull(self._root, self._checkpoint)
        self._checkpoint = delta.checkpoint
        for change in delta.changes:
            await self._watcher.notify(change)


async def _run_pull(spec: dict, ws: Workspace,
                    op: object) -> list[tuple[str, bool, str]]:
    """Run the case battery in pull mode (consumer-owned poll loop).

    Args:
        spec (dict): Parsed case file.
        ws (Workspace): Watched workspace.
        op (object): External writer operator.
    """
    await _seed(ws, op, spec)
    watcher = enable_watch(ws)
    # The hook needs a mount-framed root: virtual path plus the
    # mount-relative resource_path.
    rel = spec["watch_dir"][len(spec["mount"].rstrip("/")):].strip("/")
    root = PathSpec.from_str_path(spec["watch_dir"], resource_path=rel)
    agen = ws.watch(root)
    resource = ws.registry.mount_for(spec["mount"]).resource
    poller = ConsumerPoller(resource.delta_hook(), watcher, root)
    await poller.pump()

    async def trigger(case: dict) -> None:
        await poller.pump()

    results: list[tuple[str, bool, str]] = []
    try:
        for case in spec["cases"]:
            ok, detail = await _run_case(ws, op, trigger, agen, case)
            results.append((f"pull:{case['id']}", ok, detail))
    finally:
        await agen.aclose()
    return results


async def _run_push(spec: dict, ws: Workspace,
                    op: object) -> list[tuple[str, bool, str]]:
    """Run the case battery in push mode (webhook -> notify).

    Starts the sample webhook receiver a consumer would host, POSTs the
    Nextcloud payload each case implies, and relies on ``notify`` for
    delivery. No poller exists at all, so a delivered event can only
    have come from the webhook.

    Args:
        spec (dict): Parsed case file.
        ws (Workspace): Watched workspace.
        op (object): External writer operator.
    """
    await _seed(ws, op, spec)
    watcher = enable_watch(ws)
    agen = ws.watch(PathSpec.from_str_path(spec["watch_dir"]))
    await asyncio.sleep(0.2)
    runner = web.AppRunner(make_app(watcher, _files_prefix(), spec["mount"]))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    url = f"http://127.0.0.1:{port}/nextcloud/webhook"

    results: list[tuple[str, bool, str]] = []
    async with aiohttp.ClientSession() as session:

        async def trigger(case: dict) -> None:
            payload = _webhook_payload(case["expect"], spec["mount"])
            async with session.post(url, json=payload) as resp:
                await resp.read()

        try:
            for case in spec["cases"]:
                ok, detail = await _run_case(ws, op, trigger, agen, case)
                results.append((f"push:{case['id']}", ok, detail))
        finally:
            await agen.aclose()
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
