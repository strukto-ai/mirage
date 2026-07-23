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

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import adapters  # noqa: E402
import harness  # noqa: E402

from mirage.types import ConsistencyPolicy  # noqa: E402

HOST = "python"


def _emit_or_record(emit: list[dict] | None, report: harness.Report | None,
                    target_id: str, case: dict, exit_code: int, out: str,
                    err: str, elapsed: float) -> None:
    if emit is not None:
        emit.append({
            "target": target_id,
            "id": case["id"],
            "exit": exit_code,
            "stdout": out,
            "stderr": err,
        })
    elif report is not None:
        report.record(target_id, case["id"],
                      harness.compare(case, exit_code, out, err, elapsed))


async def run_consistency_case(target: dict, case: dict,
                               report: harness.Report | None,
                               emit: list[dict] | None) -> None:
    policy = ConsistencyPolicy(case["consistency"])
    read_ws, mutate, cleanup = await adapters.open_consistency(target, policy)
    try:
        exit_code, out = await harness.run_scenario(read_ws, mutate,
                                                    case["scenario"])
        _emit_or_record(emit, report, target["id"], case, exit_code, out, "",
                        0.0)
    finally:
        await cleanup()


async def run_target(target: dict, cases: list[dict], root: Path,
                     report: harness.Report | None,
                     emit: list[dict] | None) -> None:
    selected = [c for c in cases if target["id"] in c["targets"]]
    ws, cleanup = await adapters.open_target(target)
    try:
        for mount in target["mounts"]:
            await harness.seed_fixture(ws, mount.get("fixture"), mount["path"],
                                       root)
        for case in selected:
            if "consistency" in case:
                continue
            exit_code, out, err, elapsed = await harness.run_case(ws, case)
            _emit_or_record(emit, report, target["id"], case, exit_code, out,
                            err, elapsed)
    finally:
        await cleanup()
    for case in selected:
        if "consistency" in case:
            await run_consistency_case(target, case, report, emit)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", action="append", dest="targets")
    parser.add_argument("--emit", dest="emit")
    args = parser.parse_args()

    root = harness.integ_root()
    manifest = harness.load_targets(root)
    cases = harness.load_cases(root)

    selected = args.targets or list(manifest)
    report = None if args.emit else harness.Report()
    emit: list[dict] | None = [] if args.emit else None
    for target_id in selected:
        target = manifest[target_id]
        if HOST not in target["hosts"]:
            print(f"skip [{target_id}]: not a {HOST} host", file=sys.stderr)
            continue
        if target["mounts"][0]["resource"] not in adapters.BUILDERS:
            print(f"skip [{target_id}]: no {HOST} adapter", file=sys.stderr)
            continue
        if (target.get("service") == "nextcloud"
                and not os.environ.get("NEXTCLOUD_URL")):
            print(f"skip [{target_id}]: NEXTCLOUD_URL not set",
                  file=sys.stderr)
            continue
        if (target.get("service") == "gws" and not os.environ.get("GWS_URL")):
            print(f"skip [{target_id}]: GWS_URL not set", file=sys.stderr)
            continue
        if (target.get("service") == "email"
                and not os.environ.get("EMAIL_HOST")):
            print(f"skip [{target_id}]: EMAIL_HOST not set", file=sys.stderr)
            continue
        if (target.get("service") == "slack"
                and not os.environ.get("SLACK_URL")):
            print(f"skip [{target_id}]: SLACK_URL not set", file=sys.stderr)
            continue
        await run_target(target, cases, root, report, emit)

    if args.emit:
        Path(args.emit).write_text(json.dumps(emit))
        return
    assert report is not None
    print(f"\n{report.summary()}")
    if report.failed:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
