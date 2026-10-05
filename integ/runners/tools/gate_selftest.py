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
import contextlib
import functools
import io
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import check_case_targets as case_targets
import shard

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

import harness
import main as runner_main

from mirage.types import (
    DEFAULT_READ_TTL,
    Limit,
    MountMode,
    ReadPolicy,
    ReadSpec,
)
from mirage.vfs.ram import RAMVFS
from mirage.workspace.mount.spec import Mount

ROOT = harness.integ_root()
MAIN = ROOT / "runners" / "python" / "main.py"
TSX = ROOT / "node_modules" / ".bin" / "tsx"
CASE_TARGETS = ROOT / "runners" / "tools" / "check_case_targets.py"
FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"ok   {name}")
        return
    FAILURES.append(f"{name}: {detail}")
    print(f"FAIL {name}: {detail}")


def raises(fn, needle: str) -> tuple[bool, str]:
    """Whether fn() raises an error whose text contains needle.

    Args:
        fn (Callable): zero-argument callable expected to raise.
        needle (str): substring the error message must contain.

    Returns:
        tuple: (passed, detail) for check().
    """
    try:
        fn()
    except (KeyError, ValueError) as exc:
        text = str(exc)
        return needle in text, f"raised {text!r}, wanted {needle!r}"
    return False, "did not raise"


def with_manifest(mutate) -> dict:
    """A copy of targets.json with mutate applied, written to a temp root.

    Args:
        mutate (Callable): receives the parsed manifest and edits it.

    Returns:
        dict: the mutated manifest.
    """
    data = json.loads((ROOT / "targets.json").read_text())
    mutate(data)
    return data


def selftest_services_table() -> None:

    def drop_entry() -> None:
        data = with_manifest(lambda d: d["services"].pop("trello"))
        harness.validate_services(data)

    check(
        "services: a service with no entry is rejected",
        *raises(drop_entry, "missing an entry"),
    )

    def orphan_entry() -> None:
        data = with_manifest(
            lambda d: d["services"].update(
                {"nosuchsvc": {"python": [], "typescript": []}}
            )
        )
        harness.validate_services(data)

    check(
        "services: an entry naming no target is rejected",
        *raises(orphan_entry, "names no target"),
    )

    def half_declared() -> None:
        data = with_manifest(
            lambda d: d["services"].update({"trello": {"python": []}})
        )
        harness.validate_services(data)

    check(
        "services: an entry missing a host is rejected",
        *raises(half_declared, "must declare"),
    )


def selftest_case_validation() -> None:
    cases = [
        {"id": "dup", "targets": ["ram"], "_source": "a.json"},
        {"id": "dup", "targets": ["ram"], "_source": "b.json"},
    ]
    check(
        "cases: a duplicate id is rejected",
        *raises(lambda: harness.validate_cases(ROOT, cases), "duplicate"),
    )

    unknown = [
        {"id": "solo", "targets": ["nosuchtarget"], "_source": "a.json"}
    ]
    check(
        "cases: an unknown target ref is rejected",
        *raises(lambda: harness.validate_cases(ROOT, unknown), "unknown"),
    )

    unread = [
        {
            "id": "unread",
            "targets": ["ram"],
            "mount_read": {"/data": "bounded"},
            "_source": "a.json",
        }
    ]
    check(
        "cases: a mount_read without a read is rejected",
        *raises(lambda: harness.validate_cases(ROOT, unread), "mount_read"),
    )

    real = harness.load_cases(ROOT)
    check(
        "cases: the shipped battery passes both gates",
        len(real) > 0,
        f"loaded {len(real)} cases",
    )


def selftest_mount_read() -> None:
    """A consistency case's per-mount read override, refused and applied.

    A key naming no mount of the target would leave every leg under the
    workspace policy, so it is refused before anything opens; the needle
    carries the target id, which only that refusal names; the wrap's own
    ValueError does not. The wrap keeps a mount's mode and limits and
    carries the case's ttl, none of which the shipped cases can see: their
    mounts are bare and they set no ttl.
    """
    bound = ReadSpec(policy=ReadPolicy.BOUNDED, ttl=45)
    target = {"id": "t", "mounts": [{"path": "/data", "vfs": "ram"}]}
    check(
        "mount_read: an override naming an unmounted prefix is refused",
        *raises(
            lambda: asyncio.run(
                runner_main.adapters.open_consistency(
                    target, ReadSpec(), {"/nope": bound}
                )
            ),
            "t: mount_read names no mount: /nope",
        ),
    )

    # A refused override must still tear down what was built.
    torn: list[tuple] = []
    real_teardown = runner_main.adapters.teardown_target

    async def record_teardown(*args) -> None:
        torn.append(args)
        await real_teardown(*args)

    runner_main.adapters.teardown_target = record_teardown
    try:
        refused = raises(
            lambda: asyncio.run(
                runner_main.adapters.open_consistency(
                    target,
                    ReadSpec(),
                    {"/data": ReadSpec(policy=ReadPolicy.FRESH)},
                )
            ),
            "read: fresh",
        )
    finally:
        runner_main.adapters.teardown_target = real_teardown
    check(
        "mount_read: a refused override still tears down what it built",
        refused[0] and len(torn) == 1 and len(torn[0][1]) == 2,
        f"{refused[1]}; teardowns {torn!r}",
    )

    bare, moded, limited, kept = RAMVFS(), RAMVFS(), RAMVFS(), RAMVFS()
    limits = {"cat": Limit(timeout_seconds=5)}
    out = runner_main.adapters.apply_mount_read(
        {
            "/data": bare,
            "/ro": (moded, MountMode.READ),
            "/lim": (limited, MountMode.READ, limits),
            "/keep": kept,
        },
        {"/data": bound, "/ro": bound, "/lim": bound},
    )
    check(
        "mount_read: a bare mount keeps the workspace's mode",
        out["/data"] == Mount(vfs=bare, read=bound),
        repr(out["/data"]),
    )
    check(
        "mount_read: a read-only mount keeps its mode",
        out["/ro"] == Mount(vfs=moded, mode=MountMode.READ, read=bound),
        repr(out["/ro"]),
    )
    check(
        "mount_read: a mount keeps its command limits",
        out["/lim"]
        == Mount(
            vfs=limited, mode=MountMode.READ, command_limits=limits, read=bound
        ),
        repr(out["/lim"]),
    )
    check(
        "mount_read: a mount the override does not name is untouched",
        out["/keep"] is kept,
        repr(out["/keep"]),
    )
    got = runner_main.mount_read_of(
        {"mount_read": {"/d": "bounded"}, "ttl": 45}
    )
    check(
        "mount_read: the case's ttl rides into each override",
        got == {"/d": bound},
        repr(got),
    )
    got = runner_main.mount_read_of({"mount_read": {"/d": "bounded"}})
    check(
        "mount_read: with no ttl an override takes the default bound",
        got
        == {"/d": ReadSpec(policy=ReadPolicy.BOUNDED, ttl=DEFAULT_READ_TTL)},
        repr(got),
    )


def selftest_delete_refused() -> None:
    """A delete step on a target with no delete mutator fails, loudly.

    A plain mutate falls back to a write through the shadow, which is right
    for a writable mount. A delete has no such fallback: writing instead
    would leave the file there and let the case pass on what it never did.
    The shadow is asked afterwards, so a write that happened anyway shows.
    Disk, because it has a shadow on both hosts and no service to start.
    """
    target = {"id": "t", "mounts": [{"path": "/data", "vfs": "disk"}]}

    async def probe() -> tuple[str, bool]:
        (
            read_ws,
            mutate,
            remove,
            mutate_line,
            cleanup,
        ) = await runner_main.adapters.open_consistency(target, ReadSpec(), {})
        try:
            try:
                await harness.run_scenario(
                    read_ws,
                    mutate,
                    remove,
                    mutate_line,
                    [{"mutate": {"path": "/data/x.txt", "delete": True}}],
                )
            except RuntimeError as exc:
                refused = str(exc)
            else:
                refused = ""
            try:
                await mutate_line("test ! -e /data/x.txt")
            except RuntimeError:
                return refused, False
            return refused, True
        finally:
            await cleanup()

    try:
        refused, absent = asyncio.run(probe())
    except Exception as exc:
        check(
            "consistency: a delete with no delete mutator is refused",
            False,
            f"{type(exc).__name__}: {exc}",
        )
        return
    check(
        "consistency: a delete with no delete mutator is refused",
        "t: no delete mutator" in refused and "/data/x.txt" in refused,
        repr(refused),
    )
    check(
        "consistency: a refused delete writes nothing",
        absent,
        "the shadow has /data/x.txt",
    )


# A step's ``delete`` is a flag: only ``true`` removes. ``false`` is a
# plain mutate, the same as leaving the key out, so a case reads alike on
# both hosts. Steps the scenario runs through recording stubs.
DELETE_FLAG_STEPS = [
    {"mutate": {"path": "/data/a.txt", "content": "a", "delete": False}},
    {"mutate": {"path": "/data/b.txt", "delete": True}},
    {"mutate": {"path": "/data/c.txt", "content": "c"}},
]
DELETE_FLAG_CALLS = [
    ["write", "/data/a.txt", "a"],
    ["remove", "/data/b.txt"],
    ["write", "/data/c.txt", "c"],
]

MALFORMED_STEPS = [
    {"path": "/data/a.txt", "delete": False},
    {"path": "/data/a.txt"},
    {"path": "/data/a.txt", "content": 1},
    {"path": "/data/a.txt", "delete": "yes"},
    {"path": "/data/a.txt", "content": "a", "delete": 1},
]
MALFORMED_ERRORS = [
    'malformed mutate step {"path":"/data/a.txt","delete":false}: '
    '"content" must be a string unless "delete" is true',
    'malformed mutate step {"path":"/data/a.txt"}: '
    '"content" must be a string unless "delete" is true',
    'malformed mutate step {"path":"/data/a.txt","content":1}: '
    '"content" must be a string unless "delete" is true',
    'malformed mutate step {"path":"/data/a.txt","delete":"yes"}: '
    '"delete" must be true or false',
    'malformed mutate step {"path":"/data/a.txt","content":"a","delete":1}: '
    '"delete" must be true or false',
]


def selftest_delete_flag() -> None:
    """Only ``"delete": true`` removes; ``false`` writes its content."""
    calls: list[list[str]] = []

    async def mutate(path: str, content: bytes) -> None:
        calls.append(["write", path, content.decode()])

    async def remove(path: str) -> None:
        calls.append(["remove", path])

    async def mutate_line(command: str) -> None:
        calls.append(["line", command])

    asyncio.run(
        harness.run_scenario(
            None, mutate, remove, mutate_line, DELETE_FLAG_STEPS
        )
    )
    check(
        "consistency: only delete: true removes, false writes",
        calls == DELETE_FLAG_CALLS,
        repr(calls),
    )
    calls.clear()
    errors = []
    for spec in MALFORMED_STEPS:
        try:
            asyncio.run(
                harness.run_scenario(
                    None, mutate, remove, mutate_line, [{"mutate": spec}]
                )
            )
            errors.append(None)
        except Exception as exc:
            errors.append(
                f"{type(exc).__name__}: {exc}"
                if not isinstance(exc, ValueError)
                else str(exc)
            )
    check(
        "consistency: a mutate step without content or a boolean delete "
        "is refused",
        (errors, calls) == (MALFORMED_ERRORS, []),
        repr((errors, calls)),
    )


def selftest_case_target_defaults(typescript: bool = False) -> None:
    """Both loaders preserve explicit overrides and reject untested cases.

    Args:
        typescript (bool): exercise the TypeScript loader when true.
    """
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "targets.json").write_text((ROOT / "targets.json").read_text())
        folder = root / "unix"
        folder.mkdir()
        path = folder / "targets.json"
        inherited = {"id": "inherited", "seq": 2, "command": "echo inherited"}
        explicit = {
            "id": "explicit",
            "seq": 1,
            "targets": ["disk"],
            "command": "echo explicit",
        }
        data = {"targets": ["ram"], "cases": [inherited, explicit]}
        expected = [
            {**explicit, "_source": "unix/targets.json"},
            {**inherited, "targets": ["ram"], "_source": "unix/targets.json"},
        ]
        for label, block, valid in [
            ("inherit and override", data, True),
            (
                "empty override",
                {**data, "cases": [{**inherited, "targets": []}]},
                False,
            ),
            ("missing targets", {"cases": [inherited]}, False),
            ("invalid targets", {**data, "targets": "ram"}, False),
        ]:
            path.write_text(json.dumps(block))
            host = "ts" if typescript else "py"
            name = f"case targets ({host}): {label}"
            if typescript:
                proc = subprocess.run(
                    [
                        str(TSX),
                        "--eval",
                        "import('./runners/typescript/harness.ts').then(m => "
                        "console.log(JSON.stringify(m.loadCases(process.env.CASE_ROOT))))",
                    ],
                    cwd=ROOT,
                    env={**os.environ, "CASE_ROOT": temp},
                    capture_output=True,
                    text=True,
                )
                if valid:
                    check(
                        name,
                        proc.returncode == 0
                        and json.loads(proc.stdout) == expected,
                        proc.stderr,
                    )
                else:
                    check(
                        name,
                        proc.returncode != 0
                        and "nonempty string list" in proc.stderr,
                        proc.stderr,
                    )
            elif valid:
                check(name, harness.load_cases(root) == expected)
            else:
                check(
                    name,
                    *raises(
                        functools.partial(harness.load_cases, root),
                        "nonempty string list",
                    ),
                )


def run_main(args: list[str], env: dict) -> int:
    return run_main_out(args, env)[0]


def run_main_err(args: list[str], env: dict) -> str:
    """The python runner's stderr, for the pool's own notice.

    Args:
        args (list[str]): runner arguments.
        env (dict): environment overrides; an empty value unsets.

    Returns:
        str: stderr.
    """
    merged = {**os.environ, **env}
    for k, v in env.items():
        if v == "":
            merged.pop(k, None)
    proc = subprocess.run(
        [sys.executable, str(MAIN), *args],
        capture_output=True,
        text=True,
        env=merged,
    )
    return proc.stderr


def run_main_out(args: list[str], env: dict) -> tuple[int, str]:
    """Run the python runner, keeping stdout for an equivalence check.

    Args:
        args (list[str]): runner arguments.
        env (dict): environment overrides; an empty value unsets.

    Returns:
        tuple: exit code and stdout.
    """
    merged = {**os.environ, **env}
    for k, v in env.items():
        if v == "":
            merged.pop(k, None)
    proc = subprocess.run(
        [sys.executable, str(MAIN), *args],
        capture_output=True,
        text=True,
        env=merged,
    )
    return proc.returncode, proc.stdout


def selftest_strict_exit() -> None:
    """The deliverable: a strict run that loses a target must not be green.

    Uses --target rather than --facet so the older all-skipped facet guard
    cannot be what fires; this pins the new per-target gate on its own.
    """
    blanked = {"TRELLO_URL": ""}
    code = run_main(["--target", "trello", "--strict"], blanked)
    check("strict: a skipped target exits non-zero", code != 0, f"exit {code}")

    code = run_main(["--target", "trello"], blanked)
    check(
        "permissive: the same run still exits 0 for local convenience",
        code == 0,
        f"exit {code}",
    )

    # The partial-skip case the facet guard cannot see: one target of a
    # facet ran and another skipped for env. No facet mixes an env-free
    # target with a gated one (project's linear and trello both need a URL
    # on both hosts), so a --facet run here would lose every target and the
    # facet guard would be what fired. The verdict is asserted directly.
    partial = ["trello (TRELLO_URL)"]
    verdict = runner_main.run_verdict("project", 1, True, partial, [])
    check(
        "strict: a facet that loses only some targets fails",
        verdict is not None and verdict.startswith("strict:"),
        str(verdict),
    )
    verdict = runner_main.run_verdict("project", 1, False, partial, [])
    check(
        "permissive: that same partial facet passes",
        verdict is None,
        str(verdict),
    )
    verdict = runner_main.run_verdict("project", 0, True, partial, [])
    check(
        "facet guard: a facet that ran nothing fails first",
        verdict == "facet 'project' ran no targets",
        str(verdict),
    )
    verdict = runner_main.run_verdict(None, 1, True, [], ["nosuchtarget"])
    check(
        "strict: a target with no adapter for this host fails",
        verdict is not None and "no python adapter" in verdict,
        str(verdict),
    )
    verdict = runner_main.run_verdict(None, 1, False, [], ["nosuchtarget"])
    check(
        "permissive: a target with no adapter still passes locally",
        verdict is None,
        str(verdict),
    )

    # A facet split across CI jobs declares the services it does not
    # provision; a declared skip is tolerated, a typo'd one is rejected so
    # the list cannot rot into silently widening what --strict accepts.
    code = run_main(
        ["--target", "trello", "--strict", "--allow-skip", "trello"], blanked
    )
    check(
        "allow-skip: a declared skip is tolerated under --strict",
        code == 0,
        f"exit {code}",
    )
    code = run_main(
        ["--target", "trello", "--strict", "--allow-skip", "nosuchsvc"],
        blanked,
    )
    check(
        "allow-skip: an unknown service name is rejected",
        code != 0,
        f"exit {code}",
    )


# Read from the manifest rather than restated: a service gaining or losing
# `shared` must move the lanes the pool asserts below, not a copy here.
SHARED_SERVICES = {
    name
    for name, service in json.loads((ROOT / "targets.json").read_text())[
        "services"
    ].items()
    if service.get("shared")
}
# opfs swaps globalThis.navigator; a secrets target publishes a fetch
# function into the process-global source registry under a fixed name.
PROCESS_GLOBAL_TARGETS = [
    "opfs",
    "secrets-dead",
    "secrets-env",
    "secrets-gated",
    "secrets-implicit",
]


def selftest_fake_ports() -> None:
    """No two fakes default to one port, and none to a port CI pins for
    another fake: a fake started without --port next to one that holds
    its default fails to bind, or answers as the wrong service."""
    defaults: dict[str, int] = {}
    for config in sorted((ROOT / "server").glob("*/config.ts")):
        found = re.search(r"defaultPort:\s*(\d+)", config.read_text())
        if found is not None:
            defaults[config.parent.name] = int(found.group(1))
    check(
        "fake ports: the scan found the fakes",
        len(defaults) > 10,
        f"{sorted(defaults)}",
    )
    by_port: dict[int, list[str]] = {}
    for name, port in defaults.items():
        by_port.setdefault(port, []).append(name)
    shared = {port: names for port, names in by_port.items() if len(names) > 1}
    check(
        "fake ports: no two fakes share a default port",
        not shared,
        f"{shared}",
    )
    pinned = json.loads((ROOT / "ci" / "fakes.json").read_text())
    clashes = [
        f"{name} defaults to {port}, which CI pins for {other}"
        for name, port in defaults.items()
        for other, arm in pinned.items()
        if isinstance(arm, dict)
        and arm.get("port") == port
        and other.replace("-", "_") != name
    ]
    workflow = (
        ROOT.parent / ".github" / "workflows" / "test_integ.yml"
    ).read_text()
    clashes += [
        f"{name} defaults to {port}, which CI starts {other} on"
        for other, port_text in re.findall(
            r"server/(\w+)/main\.ts --port (\d+)", workflow
        )
        for name, port in defaults.items()
        if port == int(port_text) and other != name
    ]
    check(
        "fake ports: no default is a port CI gives another fake",
        not clashes,
        "; ".join(sorted(set(clashes))),
    )


def selftest_target_pool() -> None:
    """The pool may reorder work, never output, and never a shared fake.

    Three separable claims, because they fail separately. A target whose
    fake holds one world must hold that fake's lane; a target that scopes
    itself by run id must NOT, since serializing those would give the pool
    nothing to do (gws carries five core targets, s3 three, and they are
    the slow ones); and a concurrent run must print what a serial run
    printed, which is what lets a reader diff two CI logs.
    """
    data = json.loads((ROOT / "targets.json").read_text())
    services = harness.validate_services(data)
    alone, pool = harness.plan_run(data["targets"], services)

    targets = data["targets"]
    named = sorted(targets[i]["id"] for i in alone)
    check(
        "pool: exactly the process-global openers run alone",
        named == PROCESS_GLOBAL_TARGETS,
        f"ran alone: {named}",
    )

    lanes = {lane for _, lane in pool if not lane.startswith("solo:")}
    check(
        "pool: exactly the one-world fakes hold a lane",
        lanes == SHARED_SERVICES,
        f"lanes: {sorted(lanes)}",
    )

    scoped = [lane for i, lane in pool if targets[i].get("service") == "gws"]
    check(
        "pool: a run-scoped service does not serialize its own targets",
        len(scoped) > 1 and all(la.startswith("solo:") for la in scoped),
        f"gws lanes: {scoped}",
    )

    # GitHub selects and seeds its fixture inside each run's namespace.
    # A second repository target must be able to run beside the first.
    twinned = with_manifest(
        lambda d: d["targets"].append(
            {
                **next(t for t in d["targets"] if t["id"] == "github"),
                "id": "github-twin",
            }
        )
    )
    _, twin_pool = harness.plan_run(twinned["targets"], services)
    twin_lanes = [
        lane
        for i, lane in twin_pool
        if twinned["targets"][i]["id"].startswith("github")
    ]
    check(
        "pool: GitHub targets have independent lanes",
        len(twin_lanes) == 2
        and len(set(twin_lanes)) == 2
        and all(lane.startswith("solo:") for lane in twin_lanes),
        f"lanes: {twin_lanes}",
    )

    bad_shared = with_manifest(
        lambda d: d["services"]["github"].update({"shared": 1})
    )
    check(
        "services: a non-boolean 'shared' is rejected",
        *raises(
            functools.partial(harness.validate_services, bad_shared),
            "must be a boolean",
        ),
    )

    bad_exclusive = with_manifest(
        lambda d: next(t for t in d["targets"] if t["id"] == "opfs").update(
            {"exclusive": 1}
        )
    )
    check(
        "targets: a non-boolean 'exclusive' is rejected",
        *raises(
            functools.partial(harness.validate_targets, bad_exclusive),
            "must be a boolean",
        ),
    )

    stray_key = with_manifest(
        lambda d: d["services"]["trello"].update({"nosuchkey": True})
    )
    check(
        "services: an unknown key on a service entry is rejected",
        *raises(
            functools.partial(harness.validate_services, stray_key),
            "unknown key",
        ),
    )

    code = run_main(["--target", "ram", "--target-jobs", "0"], {})
    check("--target-jobs below one is refused", code == 2, f"exit {code}")

    # The equivalence itself, end to end. argerr is the one multi-target
    # facet that needs no service at all, so this costs a few seconds.
    serial_code, serial_out = run_main_out(
        ["--facet", "argerr", "--strict"], {}
    )
    pool_code, pool_out = run_main_out(
        ["--facet", "argerr", "--strict", "--target-jobs", "4"], {}
    )
    check(
        "pool: a concurrent run exits as the serial run did",
        serial_code == 0 and pool_code == 0,
        f"serial {serial_code}, pool {pool_code}",
    )
    check(
        "pool: a concurrent run prints what the serial run printed",
        serial_out == pool_out and serial_out != "",
        f"{len(serial_out)} vs {len(pool_out)} chars",
    )


class PoolProbe:
    """Records what the pool really had in flight.

    No end-to-end run can show this. The only facet with several targets
    and no services is ``argerr``, whose targets all finish inside one
    event-loop tick and therefore in creation order -- so buffering,
    lane exclusion and the width itself are all unobservable from
    stdout. Mutation testing confirmed it: making ``--target-jobs`` a
    no-op left every other gate green.

    Args:
        lanes (dict[str, str]): target id -> its lane.
        alone (set[str]): target ids that must overlap nothing.
        delays (dict[str, float]): how long each target takes.
    """

    def __init__(
        self, lanes: dict[str, str], alone: set[str], delays: dict[str, float]
    ) -> None:
        self.lanes = lanes
        self.alone = alone
        self.delays = delays
        self.live: set[str] = set()
        self.peak = 0
        self.lane_clashes: list[str] = []
        self.alone_clashes: list[str] = []

    async def run(
        self,
        target: dict,
        cases: list[dict],
        root: Path,
        report: object,
        emit: object,
    ) -> None:
        """Stand in for run_target, recording overlap.

        Args:
            target (dict): the target being run.
            cases (list[dict]): ignored.
            root (Path): ignored.
            report (object): this target's slot, recorded into.
            emit (object): ignored.
        """
        del cases, root, emit
        tid = target["id"]
        lane = self.lanes[tid]
        if any(self.lanes[other] == lane for other in self.live):
            self.lane_clashes.append(tid)
        if self.live and (tid in self.alone or self.alone & self.live):
            self.alone_clashes.append(tid)
        self.live.add(tid)
        self.peak = max(self.peak, len(self.live))
        # Long enough that a serial loop cannot reach the next target
        # before this one is recorded as live, and DESCENDING, so the
        # targets finish in reverse selection order. Without that the
        # ordering claim is untestable: the one service-free facet
        # finishes every target in one tick and therefore in the order
        # they were created, which is the answer either way.
        await asyncio.sleep(self.delays.get(tid, 0.02))
        self.live.discard(tid)
        if report is not None:
            report.record(tid, "probe", [])


def probe_pool(
    targets: list[dict], services: dict, width: int
) -> tuple[PoolProbe, list[str]]:
    """Drive the pool with a recorder instead of the real runner.

    Args:
        targets (list[dict]): synthetic targets, already eligible.
        services (dict): the services table they name.
        width (int): the width to drive.

    Returns:
        tuple[PoolProbe, list[str]]: the recorder, and the ids in the
        order the merged report printed them.
    """
    alone, pool = harness.plan_run(targets, services)
    lanes = {targets[i]["id"]: lane for i, lane in pool}
    lanes.update(
        {targets[i]["id"]: f"alone:{targets[i]['id']}" for i in alone}
    )
    delays = {
        t["id"]: 0.02 + 0.01 * (len(targets) - n)
        for n, t in enumerate(targets)
    }
    probe = PoolProbe(lanes, {targets[i]["id"] for i in alone}, delays)
    report = harness.Report()
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        asyncio.run(
            runner_main.run_pool(
                targets,
                [],
                ROOT,
                report,
                None,
                services,
                width,
                runner=probe.run,
            )
        )
    printed = [
        line.split("[")[1].split("]")[0]
        for line in buffer.getvalue().splitlines()
        if "[" in line
    ]
    return probe, printed


def selftest_pool_runtime() -> None:
    """The pool must actually pool, and the lanes must actually exclude.

    Every other gate here reads a pure function or diffs two stdouts.
    Neither can see the scheduler: a build that ran every target
    serially, or took no lane lock at all, passes all of them.
    """
    services = {
        "one-world": {"python": [], "typescript": [], "shared": True},
        "scoped": {"python": [], "typescript": []},
    }
    targets = [{"id": f"scoped-{n}", "service": "scoped"} for n in range(6)]
    targets += [{"id": f"world-{n}", "service": "one-world"} for n in range(3)]
    targets.append({"id": "lonely", "exclusive": True})

    wide, printed = probe_pool(targets, services, 4)
    check(
        "pool: four targets really are in flight at width 4",
        wide.peak == 4,
        f"peak {wide.peak}",
    )
    check(
        "pool: two targets on a one-world fake never overlap",
        wide.lane_clashes == [],
        f"overlapped: {wide.lane_clashes}",
    )
    check(
        "pool: an exclusive target overlaps nothing",
        wide.alone_clashes == [],
        f"overlapped: {wide.alone_clashes}",
    )
    # The targets above finish in reverse order by construction, so this
    # fails the moment a slot streams instead of buffering.
    check(
        "pool: output follows selection order, not completion order",
        printed == [t["id"] for t in targets],
        f"printed: {printed}",
    )

    narrow, _ = probe_pool(targets, services, 1)
    check(
        "pool: width one runs one at a time",
        narrow.peak == 1,
        f"peak {narrow.peak}",
    )

    # The dispatch, not the pool: `--target-jobs 4` routing to the serial
    # loop is invisible in stdout, in exit codes and to the probe above,
    # because the probe calls run_pool directly. The notice is the one
    # observable that separates the two paths.
    pooled = run_main_err(["--facet", "argerr", "--target-jobs", "4"], {})
    serial = run_main_err(["--facet", "argerr"], {})
    check(
        "pool: a width above one reaches the pool",
        "pool: " in pooled and "at width 4" in pooled,
        f"stderr: {pooled[-120:]!r}",
    )
    check(
        "pool: width one does not",
        "pool: " not in serial,
        f"stderr: {serial[-120:]!r}",
    )


def run_case_targets(root: Path) -> int:
    """Run the case-target gate under --strict against a scratch tree.

    Args:
        root (Path): repo root the gate should read.

    Returns:
        int: the gate's exit code.
    """
    result = subprocess.run(
        [sys.executable, str(CASE_TARGETS), "--strict"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    return result.returncode


def selftest_case_targets() -> None:
    """A dropped target must move the count, in both directions.

    This gate exists because a backend that cannot pass a case is normally
    just deleted from that case's ``targets``, so the check that matters is
    that the committed tree is *on* its baseline and that either edge --
    one more omission, or one fewer -- is a failure rather than a quieter
    number nobody reads.
    """
    check(
        "case targets: the committed tree sits on its baseline",
        run_case_targets(ROOT.parent) == 0,
    )

    narrow = "integ/unix/example/dialect.json"
    broad = "integ/unix/example/basic.json"
    targets = {
        f"{narrow} :: first": {"ram", "disk"},
        f"{broad} :: first": {"ram", "disk", "remote"},
        f"{broad} :: second": {"ram", "disk", "remote"},
        f"{broad} :: third": {"ram", "disk", "remote"},
    }
    rationale = {"files": {narrow: "Backend-independent dialect cases"}}
    before = case_targets.excuse(case_targets.collect(targets), rationale)
    targets[f"{narrow} :: added"] = {"ram", "disk"}
    after = case_targets.excuse(case_targets.collect(targets), rationale)
    check(
        "case targets: a file rationale covers added dialect cases",
        before == after == ({}, []),
    )
    targets[f"{broad} :: second"] = {"ram"}
    remaining, stale = case_targets.excuse(
        case_targets.collect(targets), rationale
    )
    check(
        "case targets: a file rationale cannot excuse a sibling omission",
        remaining == {f"{broad} :: second": ["disk", "remote"]} and not stale,
    )

    exceptions = ROOT / "target_exceptions.json"
    original = exceptions.read_text()
    loaded = json.loads(original)
    baseline = loaded["baseline"]
    try:
        loaded["baseline"] = baseline + 1
        exceptions.write_text(json.dumps(loaded, indent=2) + "\n")
        check(
            "case targets: a baseline above the real count fails",
            run_case_targets(ROOT.parent) != 0,
        )
        loaded["baseline"] = baseline - 1
        exceptions.write_text(json.dumps(loaded, indent=2) + "\n")
        check(
            "case targets: a baseline below the real count fails",
            run_case_targets(ROOT.parent) != 0,
        )
        loaded["baseline"] = baseline
        loaded["files"] = {"integ/unix/mv/empty_dir.json": "no longer a gap"}
        exceptions.write_text(json.dumps(loaded, indent=2) + "\n")
        check(
            "case targets: a stale exception fails",
            run_case_targets(ROOT.parent) != 0,
        )
    finally:
        exceptions.write_text(original)


def run_typescript(args: list[str], env: dict) -> tuple[int, str]:
    """Run the typescript runner, keeping stderr for the failure message.

    An unbuilt mirage package makes the runner die on import with an exit
    code that looks exactly like a gate verdict, so the tail of stderr
    rides along and says which of the two it was.

    Args:
        args (list[str]): runner arguments.
        env (dict): environment overrides; an empty value unsets.

    Returns:
        tuple: exit code and the last line of stderr.
    """
    merged = {**os.environ, **env}
    for k, v in env.items():
        if v == "":
            merged.pop(k, None)
    proc = subprocess.run(
        [str(TSX), "runners/typescript/main.ts", *args],
        capture_output=True,
        text=True,
        cwd=ROOT,
        env=merged,
    )
    lines = [ln for ln in proc.stderr.splitlines() if ln.strip()]
    errors = [ln for ln in lines if "Error" in ln or "error" in ln]
    return proc.returncode, (
        errors[0] if errors else (lines[-1] if lines else "")
    )


def ts_stdout(args: list[str]) -> str:
    """The typescript runner's stdout, for the pool equivalence check.

    Args:
        args (list[str]): runner arguments.

    Returns:
        str: stdout, or empty when the runner failed.
    """
    proc = subprocess.run(
        [str(TSX), "runners/typescript/main.ts", *args],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    return proc.stdout if proc.returncode == 0 else ""


# Minted back to back, the way the pool starts targets. A clock reading is
# unique only when the caller is slower than its resolution, which the
# serial loop was and the pool is not. Dynamic import because `tsx --eval`
# compiles as cjs, where a top-level await does not parse.
RUN_ID_PROBE = (
    "import('./runners/typescript/adapters/index.ts').then((m) => {\n"
    "  const ids = Array.from({ length: 8 }, () => m.runId())\n"
    "  console.log(new Set(ids).size)\n"
    "})\n"
)


def selftest_run_ids() -> None:
    """Two pooled targets must never be handed one namespace.

    Every backend builds its world out of the run id -- a ``/_run/<id>``
    path on gws, an s3 key prefix, a gridfs database, a dropbox account --
    so a shared one is two targets seeding and resetting each other. The
    typescript host minted ``${pid}-${Date.now()}``, which the serial loop
    made unique by being slower than a millisecond and the pool is not:
    five targets started in one tick took one id.
    """
    proc = subprocess.run(
        [str(TSX), "--eval", RUN_ID_PROBE],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    check(
        "run ids: eight minted in one tick are distinct (ts)",
        proc.stdout.strip() == "8",
        f"distinct: {proc.stdout.strip()!r} {proc.stderr[-200:]}",
    )


# planRun and targetLane are the typescript twins of what selftest_target_pool
# asserts on python, and opfs -- the target `exclusive` exists for -- runs only
# here, so the structural claims were gated on the host that cannot break them.
PLAN_PROBE = (
    "import('./runners/typescript/harness.ts').then((m) => {\n"
    "  const root = m.integRoot()\n"
    "  const services = m.loadServices(root)\n"
    "  const targets = [...m.loadTargets(root).values()]\n"
    "  const { alone, pool } = m.planRun(targets, services)\n"
    "  const named = alone.map((i) => targets[i].id).sort().join(',')\n"
    "  const lanes = [...new Set(pool.map((p) => p.lane)"
    ".filter((l) => !l.startsWith('solo:')))].sort().join(',')\n"
    "  const gws = pool.filter((p) => targets[p.at].service === 'gws')\n"
    "  const solo = gws.length > 1 && gws.every((p) => "
    "p.lane.startsWith('solo:'))\n"
    "  console.log(`${named}|${lanes}|${String(solo)}`)\n"
    "})\n"
)


def selftest_plan_run() -> None:
    """The lane split, asserted on the typescript host too.

    Args:
        None: reads the committed manifest.
    """
    proc = subprocess.run(
        [str(TSX), "--eval", PLAN_PROBE],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    want = (
        f"{','.join(PROCESS_GLOBAL_TARGETS)}|"
        f"{','.join(sorted(SHARED_SERVICES))}|true"
    )
    check(
        "pool (ts): the same targets run alone and the same fakes hold a lane",
        proc.stdout.strip() == want,
        f"got {proc.stdout.strip()!r}, wanted {want!r} {proc.stderr[-200:]}",
    )


# A consistency case whose target cannot build a shadow workspace used to be
# skipped with one stderr line and exit 0 on the typescript host only; python
# has no skip arm. The seam is probed directly because no committed case/target
# pair lacks a shadow any more, which is exactly when a regression would hide.
NO_SHADOW_PROBE = (
    "Promise.all([import('./runners/typescript/harness.ts'),\n"
    "  import('./runners/typescript/execution.ts')]).then(async ([m, e]) => {\n"
    "  const c = { id: 'probe', targets: ['t'], read: 'fresh', scenario: [],\n"
    "    expect: { exit: 0, stdout: '', stderr: '' } }\n"
    "  const t = { id: 't', hosts: [], mounts: [{ path: '/', vfs: 'ram' }] }\n"
    "  const run = await m.runConsistencyCase(async () => null, c, t)\n"
    "  const diffs = e.compare(c, run.exitCode, run.out, run.stderr, 0)\n"
    "  console.log(`${String(diffs.length > 0)}|${run.stderr.trim()}`)\n"
    "})\n"
)


def selftest_no_shadow_fails() -> None:
    """A consistency case with no shadow workspace is a recorded failure.

    Args:
        None: probes the typescript harness directly.
    """
    proc = subprocess.run(
        [str(TSX), "--eval", NO_SHADOW_PROBE],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    failed, _, line = proc.stdout.strip().partition("|")
    check(
        "consistency (ts): a target with no shadow workspace fails the case",
        failed == "true" and "no shadow workspace" in line,
        f"got {proc.stdout.strip()!r} {proc.stderr[-200:]}",
    )


# selftest_mount_read and the mount_read case rule, on the typescript host.
MOUNT_READ_PROBE = (
    "Promise.all([import('./runners/typescript/harness.ts'),\n"
    "  import('./runners/typescript/adapters/index.ts'),\n"
    "  import('@struktoai/mirage-node')]).then(async ([h, a, n]) => {\n"
    "  const out = {}\n"
    "  try {\n"
    "    h.validateCases('.', [{ id: 'unread', targets: ['ram'],\n"
    "      mount_read: { '/data': 'bounded' }, _source: 'a.json' }])\n"
    "    out.unread = 'accepted'\n"
    "  } catch (e) { out.unread = String(e.message) }\n"
    "  const bound = { policy: 'bounded', ttl: 45 }\n"
    "  const t = { id: 't', hosts: [],\n"
    "    mounts: [{ path: '/data', vfs: 'ram' }] }\n"
    "  try {\n"
    "    await a.openConsistency(t, bound, { '/nope': bound })\n"
    "    out.nope = 'opened'\n"
    "  } catch (e) { out.nope = String(e.message) }\n"
    "  const bare = new n.RAMVFS()\n"
    "  const moded = new n.RAMVFS()\n"
    "  const limited = new n.RAMVFS()\n"
    "  const kept = new n.RAMVFS()\n"
    "  const limits = { cat: { timeoutSeconds: 5 } }\n"
    "  const m = a.applyMountRead({ '/data': bare, '/ro': [moded, 'read'],\n"
    "    '/lim': [limited, 'read', limits], '/keep': kept },\n"
    "    { '/data': bound, '/ro': bound, '/lim': bound })\n"
    "  const opts = (x, vfs) => [x.vfs === vfs, x.options.mode ?? null,\n"
    "    x.options.read.policy, x.options.read.ttl]\n"
    "  out.data = opts(m['/data'], bare)\n"
    "  out.ro = opts(m['/ro'], moded)\n"
    "  out.lim = [...opts(m['/lim'], limited),\n"
    "    m['/lim'].options.commandLimits === limits]\n"
    "  out.keep = m['/keep'] === kept\n"
    "  out.ttl = h.mountReadOf({ mount_read: { '/d': 'bounded' }, ttl: 45 })\n"
    "  out.nottl = h.mountReadOf({ mount_read: { '/d': 'bounded' } })\n"
    "  console.log(JSON.stringify(out))\n"
    "})\n"
)


def selftest_mount_read_typescript() -> None:
    """selftest_mount_read's claims on the typescript host."""
    proc = subprocess.run(
        [str(TSX), "--eval", MOUNT_READ_PROBE],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    try:
        out = json.loads(proc.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as exc:
        check(
            "mount_read (ts): the probe ran",
            False,
            f"{exc}: {proc.stdout[-200:]} {proc.stderr[-400:]}",
        )
        return
    check(
        "cases (ts): a mount_read without a read is rejected",
        "mount_read" in out["unread"],
        repr(out["unread"]),
    )
    check(
        "mount_read (ts): an override naming an unmounted prefix is refused",
        "t: mount_read names no mount: /nope" in out["nope"],
        repr(out["nope"]),
    )
    check(
        "mount_read (ts): a bare mount keeps the workspace's mode",
        out["data"] == [True, None, "bounded", 45],
        repr(out["data"]),
    )
    check(
        "mount_read (ts): a read-only mount keeps its mode",
        out["ro"] == [True, "read", "bounded", 45],
        repr(out["ro"]),
    )
    check(
        "mount_read (ts): a mount keeps its command limits",
        out["lim"] == [True, "read", "bounded", 45, True],
        repr(out["lim"]),
    )
    check(
        "mount_read (ts): a mount the override does not name is untouched",
        out["keep"] is True,
        repr(out["keep"]),
    )
    check(
        "mount_read (ts): the case's ttl rides into each override",
        out["ttl"] == {"/d": {"policy": "bounded", "ttl": 45}},
        repr(out["ttl"]),
    )
    check(
        "mount_read (ts): with no ttl an override takes the default bound",
        out["nottl"] == {"/d": {"policy": "bounded", "ttl": DEFAULT_READ_TTL}},
        repr(out["nottl"]),
    )


# selftest_delete_refused on the typescript host. A delete step used to reach
# the write fallback as an empty `content`, so it wrote a zero-byte file.
DELETE_PROBE = (
    "Promise.all([import('./runners/typescript/harness.ts'),\n"
    "  import('./runners/typescript/adapters/index.ts')])"
    ".then(async ([h, a]) => {\n"
    "  const t = { id: 't', hosts: [],\n"
    "    mounts: [{ path: '/data', vfs: 'disk' }] }\n"
    "  const read = { policy: 'bounded', ttl: 45 }\n"
    "  const o = await a.openConsistency(t, read, {})\n"
    "  if (o === null) {\n"
    "    const out = { refused: 'no shadow', absent: false }\n"
    "    console.log(JSON.stringify(out))\n"
    "    return\n"
    "  }\n"
    "  let refused = ''\n"
    "  try {\n"
    "    await h.runScenario(o.ws, o.mutate, o.remove, o.mutateLine,\n"
    "      [{ mutate: { path: '/data/x.txt', delete: true } }])\n"
    "  } catch (e) { refused = String(e.message) }\n"
    "  let absent = true\n"
    "  try { await o.mutateLine('test ! -e /data/x.txt') }\n"
    "  catch { absent = false }\n"
    "  await o.cleanup()\n"
    "  console.log(JSON.stringify({ refused, absent }))\n"
    "})\n"
)


def selftest_delete_refused_typescript() -> None:
    """selftest_delete_refused's claims on the typescript host."""
    proc = subprocess.run(
        [str(TSX), "--eval", DELETE_PROBE],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    try:
        out = json.loads(proc.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as exc:
        check(
            "consistency (ts): the delete probe ran",
            False,
            f"{exc}: {proc.stdout[-200:]} {proc.stderr[-400:]}",
        )
        return
    check(
        "consistency (ts): a delete with no delete mutator is refused",
        "t: no delete mutator" in out["refused"]
        and "/data/x.txt" in out["refused"],
        repr(out["refused"]),
    )
    check(
        "consistency (ts): a refused delete writes nothing",
        out["absent"] is True,
        "the shadow has /data/x.txt",
    )


DELETE_FLAG_PROBE = (
    "import('./runners/typescript/harness.ts').then(async (h) => {\n"
    "  const calls = []\n"
    "  const dec = new TextDecoder()\n"
    "  await h.runScenario(null,\n"
    "    async (p, c) => { calls.push(['write', p, dec.decode(c)]) },\n"
    "    async (p) => { calls.push(['remove', p]) },\n"
    "    async (l) => { calls.push(['line', l]) },\n"
    f"    {json.dumps(DELETE_FLAG_STEPS)})\n"
    "  const errors = []\n"
    "  const stray = []\n"
    f"  for (const spec of {json.dumps(MALFORMED_STEPS)}) {{\n"
    "    try {\n"
    "      await h.runScenario(null, async () => { stray.push('write') },\n"
    "        async () => { stray.push('remove') }, async () => {},\n"
    "        [{ mutate: spec }])\n"
    "      errors.push(null)\n"
    "    } catch (err) { errors.push(err.message) }\n"
    "  }\n"
    "  console.log(JSON.stringify(calls))\n"
    "  console.log(JSON.stringify([errors, stray]))\n"
    "})\n"
)


def selftest_delete_flag_typescript() -> None:
    """selftest_delete_flag's claim on the typescript host."""
    proc = subprocess.run(
        [str(TSX), "--eval", DELETE_FLAG_PROBE],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    try:
        calls, (errors, stray) = (
            json.loads(line) for line in proc.stdout.strip().splitlines()[-2:]
        )
    except (ValueError, json.JSONDecodeError) as exc:
        check(
            "consistency (ts): the delete-flag probe ran",
            False,
            f"{exc}: {proc.stdout[-200:]} {proc.stderr[-400:]}",
        )
        return
    check(
        "consistency (ts): only delete: true removes, false writes",
        calls == DELETE_FLAG_CALLS,
        repr(calls),
    )
    check(
        "consistency (ts): a mutate step without content or a boolean "
        "delete is refused",
        (errors, stray) == (MALFORMED_ERRORS, []),
        repr((errors, stray)),
    )


def selftest_typescript_gates(require: bool) -> None:
    """The same two exits on the typescript host, so the gate is symmetric.

    A silent skip here would be the very thing this file exists to catch —
    a check that reports success having run nothing — so CI passes
    --require-ts and a missing tsx is a failure rather than a skip.

    Args:
        require (bool): whether an absent tsx fails instead of skipping.
    """
    if not TSX.is_file():
        if require:
            check(
                "typescript gates ran",
                False,
                f"--require-ts given but {TSX} is missing",
            )
            return
        print(
            "skip typescript gates: no tsx (run pnpm install from typescript/)"
        )
        return
    # Prove the runner starts before reading exit codes as verdicts: an
    # unbuilt mirage package dies on import with a non-zero code, which
    # would make the strict assertion below pass for the wrong reason. An
    # unknown facet exits 2 without running any case, so it costs nothing.
    code, err = run_typescript(["--facet", "__selftest_no_such_facet__"], {})
    check(
        "typescript runner starts (packages built)",
        code == 2,
        f"exit {code}: {err}",
    )

    blanked = {"TRELLO_URL": ""}
    code, err = run_typescript(["--target", "trello", "--strict"], blanked)
    check(
        "strict (ts): a skipped target exits non-zero",
        code != 0,
        f"exit {code}: {err}",
    )
    code, err = run_typescript(["--target", "trello"], blanked)
    check(
        "permissive (ts): the same run still exits 0",
        code == 0,
        f"exit {code}: {err}",
    )
    selftest_case_target_defaults(typescript=True)
    selftest_run_ids()
    selftest_plan_run()
    selftest_no_shadow_fails()
    selftest_mount_read_typescript()
    selftest_delete_refused_typescript()
    selftest_delete_flag_typescript()

    code, err = run_typescript(["--target", "ram", "--target-jobs=0"], {})
    check("--target-jobs=0 is refused (ts)", code == 2, f"exit {code}: {err}")

    code, err = run_typescript(["--target", "ram", "--target-jobs"], {})
    check(
        "--target-jobs with no value is refused (ts)",
        code == 2,
        f"exit {code}: {err}",
    )

    # The pool's two claims on this host too. The equivalence needs stdout,
    # which run_typescript drops in favour of stderr, so it spawns its own.
    code, err = run_typescript(["--target", "ram", "--target-jobs", "0"], {})
    check(
        "--target-jobs below one is refused (ts)",
        code == 2,
        f"exit {code}: {err}",
    )
    serial = ts_stdout(["--facet", "argerr", "--strict"])
    pooled = ts_stdout(["--facet", "argerr", "--strict", "--target-jobs", "4"])
    check(
        "pool (ts): a concurrent run prints what the serial run printed",
        serial == pooled and serial != "",
        f"{len(serial)} vs {len(pooled)} chars",
    )


def selftest_shard() -> None:
    """The shard jobs run every target of their facets once, and nothing
    else: a facet that puts no target into the split, a target the host
    cannot run, or a service another job provisions must not ride it."""
    manifest = json.loads((ROOT / "targets.json").read_text())
    counts = shard.case_counts(ROOT)
    by_id = {target["id"]: target for target in manifest["targets"]}
    skip = {"nextcloud", "notion"}
    for host in ("python", "typescript"):
        seconds = shard.target_seconds(shard.SECONDS, host)
        items = shard.work_items(
            manifest, ["core", "http"], host, skip, counts, seconds
        )
        ran = [target_id for ids, _ in items for target_id in ids]
        want = sorted(
            target["id"]
            for target in manifest["targets"]
            if target.get("facet", "core") in ("core", "http")
            and shard.runs_on(target, host)
            and target.get("service") not in skip
        )
        check(
            f"shard ({host}): the split holds each eligible target once",
            sorted(ran) == want,
            f"{sorted(set(ran) ^ set(want))}",
        )
        parts = shard.split(items, 2)
        spread = [
            target_id for part in parts for ids, _ in part for target_id in ids
        ]
        check(
            f"shard ({host}): the shards partition the split",
            sorted(spread) == sorted(ran),
            f"{len(spread)} vs {len(ran)}",
        )
        check(
            f"shard ({host}): no skipped service and no foreign host",
            all(
                by_id[target_id].get("service") not in skip
                and shard.runs_on(by_id[target_id], host)
                for target_id in ran
            ),
            f"{ran}",
        )
        check(
            f"shard ({host}): core and http both put work in the split",
            shard.idle_facets(manifest, ["core", "http"], items) == [],
            f"{shard.idle_facets(manifest, ['core', 'http'], items)}",
        )
        check(
            f"shard ({host}): a misspelled facet is reported idle",
            shard.idle_facets(manifest, ["core", "htpp"], items) == ["htpp"],
            f"{shard.idle_facets(manifest, ['core', 'htpp'], items)}",
        )
        check(
            f"shard ({host}): the seconds table names only targets it splits",
            set(seconds) <= set(want),
            f"{sorted(set(seconds) - set(want))}",
        )
        check(
            f"shard ({host}): a measured target weighs its seconds",
            all(
                weight == seconds[ids[0]]
                for ids, weight in items
                if len(ids) == 1 and ids[0] in seconds
            ),
            f"{[(ids, w) for ids, w in items if ids[0] in seconds][:3]}",
        )
        unmeasured = shard.work_items(
            manifest, ["core", "http"], host, skip, counts, {}
        )
        check(
            f"shard ({host}): with no seconds a target weighs its cases",
            all(
                weight == sum(counts[i] for i in ids)
                for ids, weight in unmeasured
            ),
            f"{unmeasured[:3]}",
        )
    check(
        "shard: a browser-only target is not split onto the python host",
        "opfs"
        not in [
            target_id
            for ids, _ in shard.work_items(
                manifest, ["core"], "python", set(), counts, {}
            )
            for target_id in ids
        ],
        "opfs scheduled on python",
    )


def main() -> None:
    selftest_services_table()
    selftest_case_validation()
    selftest_mount_read()
    selftest_delete_refused()
    selftest_delete_flag()
    selftest_case_target_defaults()
    selftest_strict_exit()
    selftest_fake_ports()
    selftest_target_pool()
    selftest_pool_runtime()
    selftest_case_targets()
    selftest_shard()
    selftest_typescript_gates("--require-ts" in sys.argv)
    print()
    if FAILURES:
        print(f"{len(FAILURES)} gate(s) failed", file=sys.stderr)
        sys.exit(1)
    print("all integ runner gates hold")


if __name__ == "__main__":
    main()
