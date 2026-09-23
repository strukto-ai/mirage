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
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import adapters  # noqa: E402
import harness  # noqa: E402

from mirage.concurrency import ConcurrencyLimiter  # noqa: E402
from mirage.types import ReadPolicy  # noqa: E402
from mirage.types import DEFAULT_READ_TTL, ReadSpec

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
                            notes))


def read_spec_of(case: dict) -> ReadSpec:
    """The read policy a scenario case selects.

    The value is a scenario selector, not a config value: a case names
    the policy its two workspaces run under. `ttl` rides beside it
    because `bounded` takes a bound.

    Args:
        case (dict): the integ case.
    """
    policy = ReadPolicy(case["read"])
    ttl = case.get("ttl")
    return ReadSpec(policy=policy,
                    ttl=DEFAULT_READ_TTL if ttl is None else int(ttl))


async def run_consistency_case(target: dict, case: dict,
                               report: harness.Report | None,
                               emit: list[dict] | None) -> None:
    spec = read_spec_of(case)
    read_ws, mutate, cleanup = await adapters.open_consistency(target, spec)
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
            if "read" in case:
                continue
            bound = harness.bind_mount(case, primary)
            ran = await harness.run_case(ws, bound, reasons)
            exit_code, out, err, elapsed, check_out, notes = ran
            _emit_or_record(emit, report, target["id"], bound, exit_code, out,
                            err, elapsed, check_out, notes)
    finally:
        await cleanup()
    for case in selected:
        if "read" in case:
            await run_consistency_case(target, case, report, emit)


async def run_slot(target: dict, cases: list[dict], root: Path,
                   report: harness.Report | None, emit: list[dict] | None,
                   limiter: ConcurrencyLimiter, lane: asyncio.Lock,
                   errors: list[tuple[str, BaseException]],
                   runner: harness.TargetRunner) -> None:
    """Run one target under its lane and the overall width.

    The lane is taken before the worker so a target waiting on a busy
    lane is not holding one of the four slots while it waits.

    Args:
        target (dict): the target manifest entry.
        cases (list[dict]): every loaded case.
        root (Path): the integ directory.
        report (harness.Report | None): this target's own report slot.
        emit (list[dict] | None): this target's own emit slot.
        limiter (ConcurrencyLimiter): the overall concurrency width.
        lane (asyncio.Lock): the lock for this target's lane.
        errors (list[tuple[str, BaseException]]): where a raising
            target is recorded.
        runner (harness.TargetRunner): what runs one target; the gate
            passes a recorder to watch what actually overlaps.
    """
    async with lane, limiter.acquire():
        try:
            await runner(target, cases, root, report, emit)
        except Exception as exc:
            # Recorded, not raised: a sibling still has a workspace open
            # and a backend to tear down, and aborting the gather here
            # would strand both. Every one of these is reported with its
            # traceback once the pool has drained, and fails the run.
            errors.append((target["id"], exc))


async def run_pool(
    eligible: list[dict],
    cases: list[dict],
    root: Path,
    report: harness.Report | None,
    emit: list[dict] | None,
    services: dict,
    width: int,
    runner: harness.TargetRunner | None = None
) -> list[tuple[str, BaseException]]:
    """Run every eligible target with at most ``width`` in flight.

    Targets own separate workspaces and mint a fresh run id per open, so
    they overlap safely; ``plan_run`` names the two kinds that cannot. Output
    order does not depend on completion order: every target, exclusive
    ones included, fills its own report and emit slot, and the slots are
    absorbed in selection order. So a concurrent run prints exactly what
    the serial run printed on STDOUT; stderr is not ordered, and the
    ``ERROR`` block below is appended in completion order.

    Args:
        eligible (list[dict]): targets that passed the host and env checks.
        cases (list[dict]): every loaded case.
        root (Path): the integ directory.
        report (harness.Report | None): the run's report, None when
            emitting.
        emit (list[dict] | None): the run's emit rows, or None when reporting.
        services (dict): the table from load_services.
        width (int): how many targets may be in flight.
        runner (harness.TargetRunner | None): what runs one target,
            defaulting to the real one; the gate passes a recorder.

    Returns:
        list[tuple[str, BaseException]]: the targets that raised.
    """
    run_one = run_target if runner is None else runner
    alone, pool = harness.plan_run(eligible, services)
    # On stderr, so the stdout equivalence holds, and unconditional so a
    # change that quietly routed every run down the serial loop would show
    # as this line going missing rather than as the battery merely being
    # slower. Mutation testing found that exact regression invisible.
    print(
        f"pool: {len(pool)} target(s) at width {width}, "
        f"{len(alone)} alone",
        file=sys.stderr)
    slots = [(None if report is None else harness.Report(stream=False),
              None if emit is None else []) for _ in eligible]
    errors: list[tuple[str, BaseException]] = []
    for i in alone:
        try:
            await run_one(eligible[i], cases, root, *slots[i])
        except Exception as exc:
            errors.append((eligible[i]["id"], exc))
    limiter = ConcurrencyLimiter(width)
    lanes: dict[str, asyncio.Lock] = {}
    running: list[asyncio.Task | None] = [None] * len(eligible)
    for i, lane in pool:
        lanes.setdefault(lane, asyncio.Lock())
        running[i] = asyncio.create_task(
            run_slot(eligible[i], cases, root, slots[i][0], slots[i][1],
                     limiter, lanes[lane], errors, run_one))
    # Awaited in selection order, and each slot flushed the moment every
    # slot before it has. Waiting for the whole pool before printing
    # anything would give CI one silent step and then a wall of text,
    # which is the failure mode a buffered script already has here.
    try:
        for i, task in enumerate(running):
            if task is not None:
                await task
            slot_report, slot_emit = slots[i]
            if report is not None and slot_report is not None:
                report.absorb(slot_report)
            if emit is not None and slot_emit is not None:
                emit.extend(slot_emit)
    finally:
        # `run_slot` catches Exception, so only a BaseException reaches
        # here -- a KeyboardInterrupt, or a SystemExit out of a library.
        # Leaving the rest of the pool unawaited would have the loop
        # cancel them at teardown, interrupting `run_target`'s cleanup
        # mid-await and leaking the mongo databases, s3 buckets and fake
        # subprocesses it exists to reclaim.
        rest = [t for t in running if t is not None and not t.done()]
        for task in rest:
            task.cancel()
        if rest:
            await asyncio.gather(*rest, return_exceptions=True)
        # Inside the finally, not after it: a BaseException on its way out
        # would otherwise discard every failure the pool had already
        # recorded, which is the diagnosis the drain exists to preserve.
        for target_id, exc in errors:
            print(f"ERROR [{target_id}]", file=sys.stderr)
            traceback.print_exception(type(exc), exc, exc.__traceback__)
    return errors


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
    # How many targets may be in flight. One is the plain loop below, which
    # stays the default so a local run is sequential and debuggable and so
    # landing the scheduler changes nothing until a workflow line asks for it.
    parser.add_argument("--target-jobs",
                        dest="target_jobs",
                        type=int,
                        default=1)
    args = parser.parse_args()
    if args.target_jobs < 1:
        print("--target-jobs takes an integer >= 1", file=sys.stderr)
        sys.exit(2)

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
        if target["mounts"][0]["vfs"] not in adapters.BUILDERS:
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

    # One worker means the old loop, unchanged. The pool cannot stand in for
    # it: a target waiting on a busy lane lets a later one take the worker
    # first, so the default run would quietly reorder itself.
    if args.target_jobs == 1:
        for target in eligible:
            await run_target(target, cases, root, report, emit)
        raised = []
    else:
        raised = await run_pool(eligible, cases, root, report, emit, services,
                                args.target_jobs)

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
        # No file, deliberately, where the report path prints partial counts:
        # parity.py diffs two emits by (target, id), so a short one reads as
        # a pile of ONLY-PY/ONLY-TS rows rather than as the run that broke.
        if raised:
            print(f"{len(raised)} target(s) failed to run", file=sys.stderr)
            sys.exit(1)
        Path(args.emit).write_text(json.dumps(emit))
        return
    assert report is not None
    print(f"\n{report.summary()}")
    # Printed before the exit, because a pooled run that lost a target
    # still ran every other one and its counts are the answer to "what
    # else broke". The serial loop lets the exception abort the run, so
    # this is the one place the two modes deliberately differ.
    if raised:
        print(f"{len(raised)} target(s) failed to run", file=sys.stderr)
        sys.exit(1)
    if report.failed:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
