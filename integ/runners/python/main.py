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
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import adapters  # noqa: E402
import harness  # noqa: E402

HOST = "python"


async def run_target(target: dict, cases: list[dict], root: Path,
                     report: harness.Report | None,
                     emit: list[dict] | None) -> None:
    ws, cleanup = await adapters.open_target(target)
    try:
        for mount in target["mounts"]:
            await harness.seed_fixture(ws, mount.get("fixture"), mount["path"],
                                       root)
        for case in cases:
            if target["id"] not in case["targets"]:
                continue
            exit_code, out, err, elapsed = await harness.run_case(ws, case)
            if emit is not None:
                emit.append({
                    "target": target["id"],
                    "id": case["id"],
                    "exit": exit_code,
                    "stdout": out,
                    "stderr": err,
                })
            elif report is not None:
                report.record(
                    target["id"], case["id"],
                    harness.compare(case, exit_code, out, err, elapsed))
    finally:
        await cleanup()


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
