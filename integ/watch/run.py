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

from mirage import MountMode, Workspace
from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.resource.nextcloud import NextcloudConfig, NextcloudResource
from mirage.types import PathSpec
from mirage.watch import enable_watch

CASE_DIR = Path(__file__).resolve().parent
EVENT_TIMEOUT = 20.0


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


def _check_verify(verify: dict, out: str) -> tuple[bool, str]:
    """Assert a post-event read.

    Args:
        verify (dict): {"cmd", "contains"?|"absent"?}.
        out (str): Stripped command stdout.
    """
    if "contains" in verify:
        return verify["contains"] in out, f"contains {verify['contains']!r}"
    if "absent" in verify:
        return verify["absent"] not in out, f"absent {verify['absent']!r}"
    return True, "no-op"


async def _run_case(ws: Workspace, op: object, watcher: object, agen: object,
                    case: dict) -> tuple[bool, str]:
    """Run one mutate -> event -> verify case.

    Args:
        ws (Workspace): Watched workspace.
        op (object): External writer operator.
        watcher (object): The attached watcher, for ``nudge``.
        agen (object): The ``watch`` async iterator.
        case (dict): One case from the file.
    """
    want = case["expect"]
    await _mutate(op, case["mutate"])
    watcher.nudge(PathSpec.from_str_path(want["path"]))
    try:
        change = await _await_event(agen, want["path"])
    except TimeoutError:
        return False, f"no event for {want['path']} within {EVENT_TIMEOUT}s"
    if change.kind.value != want["kind"]:
        return False, f"kind {change.kind.value} != {want['kind']}"
    result = await ws.execute(case["verify"]["cmd"])
    out = (await result.stdout_str()).strip()
    ok, detail = _check_verify(case["verify"], out)
    if not ok:
        return False, f"verify failed ({detail}) got {out!r}"
    return True, f"{want['kind']} + verify {detail}"


async def _run_file(spec: dict) -> list[tuple[str, bool, str]]:
    """Run every case in one case file.

    Args:
        spec (dict): Parsed case file.
    """
    builder = BUILDERS.get(spec["resource"])
    if builder is None:
        return [(spec["resource"], False, "no builder")]
    built = builder(spec)
    if built is None:
        print(f"skip [{spec['resource']}]: deployment env absent",
              file=sys.stderr)
        return []
    ws, op = built
    results: list[tuple[str, bool, str]] = []
    await ws.execute(f"rm -rf {spec['watch_dir']}")
    await ws.execute(f"mkdir -p {spec['watch_dir']}")
    for name in spec["seed"]:
        await op.write(f"data/{name}", b"seed")
    watcher = enable_watch(ws, poll_interval=spec["poll_interval"])
    agen = ws.watch(PathSpec.from_str_path(spec["watch_dir"]))
    await asyncio.sleep(spec["poll_interval"] * 2)
    try:
        for case in spec["cases"]:
            ok, detail = await _run_case(ws, op, watcher, agen, case)
            results.append((case["id"], ok, detail))
    finally:
        await agen.aclose()
        await ws.close()
    return results


async def main() -> None:
    files = sorted(CASE_DIR.glob("*.json"))
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
