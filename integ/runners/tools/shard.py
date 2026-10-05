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
"""Run one shard of the facets' targets as several runner processes.

A runner is one process whose `--target-jobs` lanes share a single core,
and the battery is CPU-bound there, so a 4-core runner sat mostly idle.
This driver splits the targets the host runs across the shard jobs by their
measured seconds (`ci/shard_seconds.json`), then runs each target as its
own runner process, `--procs` at a time, largest first, and prints each log
whole as it finishes with the target's time.

Usage: shard.py --shard I --shards N --procs P --host python|typescript
       [--facet F]... [--allow-skip SERVICES] [--emit-dir DIR]
       -- <runner command and its flags>
"""

import argparse
import json
import subprocess
import sys
import tempfile
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

INTEG = Path(__file__).resolve().parents[2]
SECONDS = INTEG / "ci" / "shard_seconds.json"
SKIP_DIRS = {"node_modules", "generated", "truth", "fixtures"}


def case_counts(root: Path) -> Counter:
    """How many cases name each target, over every case file.

    Args:
        root (Path): the integ directory.
    """
    counts: Counter = Counter()
    for path in root.rglob("*.json"):
        if SKIP_DIRS & set(path.relative_to(root).parts):
            continue
        try:
            doc = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not isinstance(doc, dict) or not isinstance(doc.get("cases"), list):
            continue
        for case in doc["cases"]:
            if not isinstance(case, dict):
                continue
            targets = case.get("targets", doc.get("targets"))
            if isinstance(targets, list):
                counts.update(targets)
    return counts


def target_seconds(path: Path, host: str) -> dict[str, int]:
    """Each target's measured battery seconds on `host`.

    Args:
        path (Path): the seconds table, `ci/shard_seconds.json`.
        host (str): `python` or `typescript`, the runner's language.
    """
    return json.loads(path.read_text())[host]


def runs_on(target: dict, host: str) -> bool:
    """Whether the runner for `host` runs this target at all.

    Args:
        target (dict): the target manifest entry.
        host (str): `python` or `typescript`, the runner's language.
    """
    return any(h == host or h.startswith(f"{host}-") for h in target["hosts"])


def work_items(
    manifest: dict,
    facets: list[str],
    host: str,
    skip: set[str],
    counts: Counter,
    seconds: dict[str, int],
) -> list[tuple[list[str], int]]:
    """The facets' targets as (ids, seconds), one runner process each.

    A target the host does not run, or one on a service this job leaves to
    another, is left out: it would cost a process that only prints a skip,
    and its cases would weigh on the split as if they ran. A target on a
    `shared` service shares one world with every other target on it, so
    those travel together as one item, the way the runner gives them one
    lane. A target with no measured seconds yet is estimated from its case
    count at the average seconds per case of the targets that have them.

    Args:
        manifest (dict): targets.json.
        facets (list[str]): the facets to run.
        host (str): `python` or `typescript`, the runner's language.
        skip (set[str]): services another job provisions.
        counts (Counter): cases per target.
        seconds (dict[str, int]): measured seconds per target on `host`.
    """
    services = manifest.get("services", {})
    lanes: dict[str, list[str]] = {}
    for target in manifest["targets"]:
        if target.get("facet", "core") not in facets:
            continue
        if not runs_on(target, host) or target.get("service") in skip:
            continue
        service = target.get("service")
        shared = service is not None and services.get(service, {}).get(
            "shared", False
        )
        lanes.setdefault(service if shared else target["id"], []).append(
            target["id"]
        )
    known = [i for ids in lanes.values() for i in ids if i in seconds]
    cases = sum(counts[i] for i in known)
    rate = sum(seconds[i] for i in known) / cases if cases else 1.0
    return [
        (ids, round(sum(seconds.get(i, counts[i] * rate) for i in ids)))
        for ids in lanes.values()
    ]


def idle_facets(
    manifest: dict, facets: list[str], items: list[tuple[list[str], int]]
) -> list[str]:
    """The requested facets that put no target into the split.

    A misspelled or emptied facet would otherwise drop out in silence while
    the others run, which reads as that facet passing.

    Args:
        manifest (dict): targets.json.
        facets (list[str]): the facets asked for.
        items (list[tuple[list[str], int]]): what work_items returned.
    """
    by_id = {target["id"]: target for target in manifest["targets"]}
    seen = {
        by_id[target_id].get("facet", "core")
        for ids, _ in items
        for target_id in ids
    }
    return sorted(set(facets) - seen)


def split(
    items: list[tuple[list[str], int]], shards: int
) -> list[list[tuple[list[str], int]]]:
    """Largest first onto the lightest shard, so shards weigh the same.

    Args:
        items (list[tuple[list[str], int]]): work items and weights.
        shards (int): how many shard jobs there are.
    """
    out: list[list[tuple[list[str], int]]] = [[] for _ in range(shards)]
    load = [0] * shards
    for item in sorted(items, key=lambda it: (-it[1], it[0])):
        lightest = load.index(min(load))
        out[lightest].append(item)
        load[lightest] += item[1]
    return out


def run_item(
    ids: list[str], command: list[str], emit_dir: Path | None, logs: Path
) -> tuple[list[str], int, float, Path]:
    """One runner process over one work item, its output to a file.

    Args:
        ids (list[str]): the target ids.
        command (list[str]): the runner command and its flags.
        emit_dir (Path | None): where each process writes its emit.
        logs (Path): the directory for the process's log.
    """
    argv = list(command)
    for target_id in ids:
        argv += ["--target", target_id]
    if emit_dir is not None:
        argv += ["--emit", str(emit_dir / f"{ids[0]}.json")]
    log = logs / f"{ids[0]}.log"
    start = time.monotonic()
    with log.open("wb") as out:
        code = subprocess.run(
            argv, stdout=out, stderr=subprocess.STDOUT, check=False
        ).returncode
    return ids, code, time.monotonic() - start, log


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shard", type=int, required=True)
    parser.add_argument("--shards", type=int, required=True)
    parser.add_argument("--procs", type=int, required=True)
    parser.add_argument(
        "--host", required=True, choices=("python", "typescript")
    )
    parser.add_argument("--facet", action="append", dest="facets")
    parser.add_argument("--allow-skip", dest="allow_skip", default="")
    parser.add_argument("--emit-dir", dest="emit_dir")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or not 0 <= args.shard < args.shards or args.procs < 1:
        parser.error(
            "needs 0 <= --shard < --shards, --procs >= 1 and a "
            "runner command after --"
        )
    manifest = json.loads((INTEG / "targets.json").read_text())
    skip = {name for name in args.allow_skip.split(",") if name}
    unknown = skip - set(manifest.get("services", {}))
    if unknown:
        parser.error(f"--allow-skip names no service: {', '.join(unknown)}")
    facets = args.facets or ["core"]
    items = work_items(
        manifest,
        facets,
        args.host,
        skip,
        case_counts(INTEG),
        target_seconds(SECONDS, args.host),
    )
    idle = idle_facets(manifest, facets, items)
    if idle:
        parser.error(
            f"--facet puts no {args.host} target in the split: "
            f"{', '.join(idle)}"
        )
    mine = split(items, args.shards)[args.shard]
    if not mine:
        print(
            f"shard {args.shard} of {args.shards} got no targets",
            file=sys.stderr,
        )
        sys.exit(2)
    emit_dir = None
    if args.emit_dir is not None:
        emit_dir = Path(args.emit_dir)
        emit_dir.mkdir(parents=True, exist_ok=True)
    timings: list[tuple[float, list[str], int, int]] = []
    failed = 0
    with (
        tempfile.TemporaryDirectory() as tmp,
        ThreadPoolExecutor(args.procs) as pool,
    ):
        weights = {tuple(ids): weight for ids, weight in mine}
        running = [
            pool.submit(run_item, ids, command, emit_dir, Path(tmp))
            for ids, _ in mine
        ]
        for done in as_completed(running):
            ids, code, seconds, log = done.result()
            print(
                f"=== {' '.join(ids)}: exit {code} in {seconds:.0f}s ===",
                flush=True,
            )
            sys.stdout.buffer.write(log.read_bytes())
            sys.stdout.flush()
            timings.append((seconds, ids, weights[tuple(ids)], code))
            failed += code != 0
    print(f"\nshard {args.shard} of {args.shards}, {args.procs} processes:")
    for seconds, ids, weight, code in sorted(timings, reverse=True):
        print(
            f"  {seconds:6.0f}s  est {weight:5d}s  exit {code}  "
            f"{' '.join(ids)}"
        )
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
