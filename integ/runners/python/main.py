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
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import adapters  # noqa: E402
import harness  # noqa: E402

from mirage.types import ConsistencyPolicy  # noqa: E402

HOST = "python"


def _emit_or_record(emit: list[dict] | None,
                    report: harness.Report | None,
                    target_id: str,
                    case: dict,
                    exit_code: int,
                    out: str,
                    err: str,
                    elapsed: float,
                    check_out: str | None = None,
                    notes: list[str] | None = None) -> None:
    if emit is not None:
        emit.append({
            "target": target_id,
            "id": case["id"],
            "exit": exit_code,
            "stdout": out,
            "stderr": err,
            "check": check_out,
        })
    elif report is not None:
        report.record(
            target_id, case["id"],
            harness.compare(case, exit_code, out, err, elapsed, check_out,
                            notes), elapsed, harness.scenario_verb(case))


async def run_consistency_case(target: dict, case: dict,
                               report: harness.Report | None,
                               emit: list[dict] | None) -> None:
    policy = ConsistencyPolicy(case["consistency"])
    read_ws, mutate, cleanup = await adapters.open_consistency(target, policy)
    try:
        started = time.monotonic()
        exit_code, out = await harness.run_scenario(read_ws, mutate,
                                                    case["scenario"])
        # Measured, not zero: a consistency scenario on s3 or gridfs runs
        # several remote mutations, and recording it as free dragged the
        # profile's totals and percentiles down.
        elapsed = time.monotonic() - started
        _emit_or_record(emit, report, target["id"], case, exit_code, out, "",
                        elapsed)
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
            if mount.get("seed_root"):
                await harness.seed_mount_root(ws, mount["path"])
        # Sessions a case can name via its "session" field, through the
        # two doors a host really has. A string names one of the
        # target's profiles (`profile=`), which is the whole document that
        # session runs under. A mapping is an inline document added to
        # the default profile (`permissions=`): it may add ask and deny
        # rules and hides, never an allow list, so a session that needs
        # its own allow list has to be a profile. An empty mapping is the
        # default profile with nothing added.
        # A profile written by a script is ready only after hydration,
        # which every embedding program already awaits before it creates
        # a session; the battery is a program like any other.
        await ws.ensure_sessions_loaded()
        for session_id, spec in (target.get("sessions") or {}).items():
            if isinstance(spec, str):
                ws.create_session(session_id, profile=spec)
            else:
                ws.create_session(session_id, permissions=spec or None)
        primary = target["mounts"][0]["path"]
        # Only a target carrying a permissions document has a verdict
        # for `explain` to predict, and only there is the extra dry run
        # per case worth its time. The reasons double as the tell that a
        # refusal came from the policy layer rather than from the
        # command itself.
        reasons = harness.rule_reasons({
            "profiles": target.get("profiles"),
            "sessions": target.get("sessions"),
        })
        for case in selected:
            if "consistency" in case:
                continue
            bound = harness.bind_mount(case, primary)
            ran = await harness.run_case(ws, bound, reasons)
            exit_code, out, err, elapsed, check_out, notes = ran
            _emit_or_record(emit, report, target["id"], bound, exit_code, out,
                            err, elapsed, check_out, notes)
    finally:
        await cleanup()
    for case in selected:
        if "consistency" in case:
            await run_consistency_case(target, case, report, emit)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", action="append", dest="targets")
    parser.add_argument("--facet", dest="facet")
    parser.add_argument("--emit", dest="emit")
    parser.add_argument("--strict", action="store_true")
    # A facet can be split across CI jobs (core's databases and vector
    # stores run in integ-database/integ-data), so a job names the
    # services it knowingly does not provision. Anything skipping outside
    # this list is a broken job, which is the whole point of --strict.
    parser.add_argument("--allow-skip", dest="allow_skip", default="")
    parser.add_argument("--target-jobs",
                        dest="target_jobs",
                        type=int,
                        default=1)
    parser.add_argument("--profile", action="store_true")
    args = parser.parse_args()

    root = harness.integ_root()
    manifest = harness.load_targets(root)
    services = harness.load_services(root)
    cases = harness.load_cases(root)

    # Targets are grouped into facets so CI can run one backend family per job;
    # a target with no facet belongs to "core", which the shared battery runs.
    if args.facet:
        selected = [
            tid for tid, t in manifest.items()
            if (t.get("facet") or "core") == args.facet
        ]
        if not selected:
            print(f"no targets in facet {args.facet!r}", file=sys.stderr)
            sys.exit(2)
    else:
        selected = args.targets or list(manifest)
    report = None if args.emit else harness.Report()
    emit: list[dict] | None = [] if args.emit else None
    ran = 0
    allow_skip = harness.parse_allow_skip(services, args.allow_skip)
    env_skipped: list[str] = []
    eligible: list[dict] = []
    for target_id in selected:
        target = manifest[target_id]
        if HOST not in target["hosts"]:
            print(f"skip [{target_id}]: not a {HOST} host", file=sys.stderr)
            continue
        if target["mounts"][0]["resource"] not in adapters.BUILDERS:
            print(f"skip [{target_id}]: no {HOST} adapter", file=sys.stderr)
            continue
        missing = harness.missing_env(services, target, HOST)
        if missing:
            print(f"skip [{target_id}]: {', '.join(missing)} not set",
                  file=sys.stderr)
            if target.get("service") not in allow_skip:
                env_skipped.append(f"{target_id} ({', '.join(missing)})")
            continue
        eligible.append(target)
        ran += 1

    # Targets own separate workspaces, so they overlap safely -- except when
    # two speak to the SAME fake (cli-gh and github, cli-ntn and notion,
    # qdrant and qdrant-window). Those share a lane and stay sequential; the
    # rest are bound only by the overall width.
    if args.target_jobs < 1:
        print("--target-jobs takes an integer >= 1", file=sys.stderr)
        sys.exit(2)

    # One worker means the old loop, unchanged. The lane scheduler below
    # cannot stand in for it: a target waiting on a busy lane lets a later
    # one from another lane take the worker first, and with `s3` carrying
    # three targets and `gws` four, the default run would quietly reorder
    # itself.
    if args.target_jobs == 1:
        for target in eligible:
            started = time.monotonic()
            await run_target(target, cases, root, report, emit)
            if report is not None:
                report.note_target_wall(target["id"],
                                        time.monotonic() - started)
    else:
        semaphore = asyncio.Semaphore(args.target_jobs)
        lane_locks: dict[str, asyncio.Lock] = {}
        # One slot per invocation, not per target id. `--target x --target x`
        # is two runs, and keying by id made both of them write the second
        # slot and then merged that slot twice, so two runs reported as four.
        slots: list[tuple[harness.Report | None, list[dict] | None]] = []
        errors: list[BaseException] = []

        async def run_one(
                target: dict, lane: str,
                slot: tuple[harness.Report | None, list[dict] | None]) -> None:
            slot_report, slot_emit = slot
            async with lane_locks[lane], semaphore:
                started = time.monotonic()
                try:
                    await run_target(target, cases, root, slot_report,
                                     slot_emit)
                except Exception as exc:  # reported once every target is done
                    errors.append(exc)
                finally:
                    if slot_report is not None:
                        slot_report.note_target_wall(
                            target["id"],
                            time.monotonic() - started)

        tasks = []
        for target in eligible:
            slot = (
                None if report is None else harness.Report(stream=False),
                None if emit is None else [],
            )
            slots.append(slot)
            lane = target.get("service") or f"solo:{target['id']}"
            lane_locks.setdefault(lane, asyncio.Lock())
            tasks.append(asyncio.create_task(run_one(target, lane, slot)))
        if tasks:
            await asyncio.gather(*tasks)
        # Merged in declared target order, so a concurrent run prints what a
        # serial run printed.
        for slot_report, slot_emit in slots:
            if report is not None and slot_report is not None:
                report.absorb(slot_report)
            if emit is not None and slot_emit is not None:
                emit.extend(slot_emit)
        if errors:
            raise errors[0]

    # A skip is one line on stderr and exit 0, so a facet whose service
    # never came up (or whose env var got renamed in the workflow)
    # reports green having tested nothing. Every facet has targets on
    # both hosts, so zero of them running is always a broken job.
    if args.facet and ran == 0:
        print(f"facet {args.facet!r} ran no targets", file=sys.stderr)
        sys.exit(2)

    # The facet guard above only fires when *every* target skipped, so a
    # two-target facet that loses one still reports green. CI passes
    # --strict, which starts every service its facet declares, so there a
    # missing variable is a broken job rather than a local convenience.
    if args.strict and env_skipped:
        print(
            f"strict: {len(env_skipped)} target(s) skipped for missing "
            f"env: {'; '.join(env_skipped)}",
            file=sys.stderr)
        sys.exit(2)

    if args.emit:
        Path(args.emit).write_text(json.dumps(emit))
        return
    assert report is not None
    if args.profile:
        print(report.profile())
    print(f"\n{report.summary()}")
    if report.failed:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
