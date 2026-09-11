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
"""One arm of the cross-language snapshot battery.

``write`` builds a world, records what it observes, and leaves a tar.
``read`` builds the same world fresh, loads the other arm's tar into it,
and records the same observations. ``cross.sh`` diffs the two files, so
every plane a snapshot carries -- the document, the session tables, the
installs, the live-only mounts -- is compared rather than re-asserted
per case, and a case's own ``expect`` blocks pin the absolute truths
that a matching pair of wrong answers would otherwise hide.
"""

# The shared runner is a directory of modules, not an installed
# package, so it has to be on the path before it can be imported and
# every import below is E402 by construction. isort splits a line that
# carries a `noqa`, which drops the marker off the half it moves, so
# the rule is turned off for the file rather than per line.
# ruff: noqa: E402
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

RUNNERS = Path(__file__).resolve().parents[1] / "runners" / "python"
sys.path.insert(0, str(RUNNERS))

import adapters
import harness

from mirage.policy import Policy
from mirage.policy.types import (CommandContext, Deny, OpsContext,
                                 SessionContext)
from mirage.runtime.types import ScriptSource
from mirage.types import DriftPolicy
from mirage.workspace import Workspace
from mirage.workspace.snapshot.keys import StateKey

SUITE = Path(__file__).with_name("cases.json")
HOST = "python"
RUNTIME = "monty"


class RulePolicy(Policy):
    """A coded policy the case declares and the loader re-registers.

    A snapshot names a policy class and cannot carry it, so both arms
    register one of the same name and the battery compares what the
    restored workspace reports.
    """

    def __init__(self, rule: dict[str, Any]) -> None:
        self.rule = rule

    async def pre_command(self, ctx: CommandContext) -> Deny | None:
        if ctx.command in self.rule.get("commands", []):
            return Deny(self.rule["reason"])
        return None

    async def pre_ops(self, ctx: OpsContext) -> Deny | None:
        if ctx.path.virtual in self.rule.get("paths", []):
            return Deny(self.rule["reason"])
        return None

    async def pre_session(self, ctx: SessionContext) -> Deny | None:
        if ctx.key in self.rule.get("vars", []):
            return Deny(self.rule["reason"])
        return None


def host_script(case: dict[str, Any], key: str) -> dict[str, Any]:
    """This host's half of a two-language script declaration.

    A policy program and a CLI program are written once per language
    and name the runtime that language has: python's default world
    carries monty and TypeScript's carries pyodide, so the document a
    snapshot carries names a runtime the other arm does not have. That
    is what the loader's ``profiles=`` and ``runtimes=`` are for, and
    the case says so with ``load.profiles`` / ``load.runtimes``.

    Args:
        case (dict[str, Any]): the case document.
        key (str): ``script`` or ``script_cli``.
    """
    return dict(case[key][HOST])


def target_of(case: dict[str, Any]) -> dict[str, Any]:
    """The target this host opens, with its script placeholder filled.

    Args:
        case (dict[str, Any]): the case document.
    """
    target = json.loads(json.dumps(case["target"]))
    profiles = target.get("profiles")
    if profiles:
        for name, doc in list(profiles.items()):
            if doc != "@script":
                continue
            script = host_script(case, "script")
            profiles[name] = {
                "commands": {
                    "allow": ["echo", "cat", "ls", "rm", "touch"]
                },
                "policy": {
                    "script": {
                        "source": script["source"],
                        "language": script["language"],
                    },
                    "runtime": script["runtime"],
                },
            }
    return target


def profile_documents(case: dict[str, Any]) -> dict[str, Any] | None:
    """The documents a reader states for itself, or None to use the tar's.

    Args:
        case (dict[str, Any]): the case document.
    """
    if not case.get("load", {}).get("profiles"):
        return None
    return adapters.scripted_profiles(target_of(case).get("profiles"))


def script_cli_spec(case: dict[str, Any]) -> "adapters.CLISpec | None":
    """The case's own program as a spec in this host's language.

    Args:
        case (dict[str, Any]): the case document.
    """
    cli = case.get("script_cli")
    if cli is None:
        return None
    script = host_script(case, "script_cli")
    return adapters.CLISpec(name=cli["name"],
                            script=ScriptSource(source=script["source"],
                                                language=script["language"]),
                            runtime=script["runtime"])


def install_script_cli(ws: Workspace, case: dict[str, Any]) -> None:
    """Install the case's own program, written in this host's language.

    Args:
        ws (Workspace): the workspace to install into.
        case (dict[str, Any]): the case document.
    """
    spec = script_cli_spec(case)
    if spec is not None:
        ws.register_cli(spec.name, spec)


async def build(case: dict[str, Any], run_id: str, *, sessions: bool):
    """Open this case's world and add what a target cannot declare.

    ``open_target`` is the battery's own door and states most of the
    target document -- mounts, named profiles, the default profile,
    account CLIs, the env block. A runtime, a coded policy and the
    target's own sessions are added afterwards, which is what a host
    really does: a runtime appends to the world, a profile policy's
    engine is built by name at evaluation, ``policies.add`` is the
    registration door, and a session is created once the store has
    been hydrated.

    Args:
        case (dict[str, Any]): the case document.
        run_id (str): this arm's own run, so its fake world is its own.
        sessions (bool): create the target's sessions. The writing arm
            does; the reading arm's host world exists only to build the
            resources the loader is handed, and the sessions it reads
            come from the tar.
    """
    # No runtime is added: python's default world carries monty and
    # TypeScript's carries pyodide, so each arm's script already names
    # a runtime it has. What the reading arm proves instead is the
    # loader's own `runtimes` knob, since a snapshot carries none.
    target = target_of(case)
    ws, cleanup = await adapters.open_target(target)
    install_script_cli(ws, case)
    await ws.ensure_sessions_loaded()
    if sessions:
        for sid, spec in (target.get("sessions") or {}).items():
            if isinstance(spec, str):
                ws.create_session(sid, profile=spec)
            else:
                ws.create_session(sid, permissions=spec or None)
    return ws, cleanup


async def observe(ws: Workspace, steps: list[dict[str, Any]],
                  literals: dict[str, str],
                  manifest: dict[str, Any] | None) -> list[Any]:
    """Run the verify steps and answer what each one saw.

    The answers are the comparison: both arms run the same steps and
    ``cross.sh`` diffs the lists, so a plane one language carries and
    the other drops shows up without a per-case expectation for it.

    Args:
        ws (Workspace): the workspace under test.
        steps (list[dict[str, Any]]): the verify steps.
        literals (dict[str, str]): the per-run credential strings an
            ``absent`` step must not find in the manifest.
        manifest (dict[str, Any] | None): the loaded state, for the
            steps that read it; None on the writing arm, which reads
            the tar it just wrote.
    """
    seen: list[Any] = []
    for step in steps:
        seen.append(await one(ws, step, literals, manifest))
    return seen


async def one(ws: Workspace, step: dict[str, Any], literals: dict[str, str],
              manifest: dict[str, Any] | None) -> Any:
    """One verify step's observation, checked against its own expect.

    Args:
        ws (Workspace): the workspace under test.
        step (dict[str, Any]): the step document.
        literals (dict[str, str]): credential strings for ``absent``.
        manifest (dict[str, Any] | None): the loaded state or None.
    """
    op = step["op"]
    if op == "exec":
        result = await ws.execute(step["command"],
                                  session_id=step.get("session"))
        got = {
            "exit": result.exit_code,
            "stdout": await result.stdout_str(),
            "stderr": await result.stderr_str(),
            "refusal": result.refusal.reason if result.refusal else None,
        }
        check(step, got)
        return got
    if op == "write":
        await ws.fs.write(step["path"], step["data"].encode())
        return None
    if op == "read":
        return (await ws.fs.read(step["path"])).decode()
    if op == "readdir":
        return sorted(await ws.fs.readdir(step["path"]))
    if op == "answer":
        await harness.answer_decisions(ws, step["mode"])
        return None
    if op == "sessions":
        # The default session's id is minted per workspace and travels
        # in the snapshot, so it is named rather than spelled: the two
        # arms compare which sessions exist, not which uuid this run
        # happened to draw.
        return sorted("<default>" if s.session_id ==
                      ws.default_session_id else s.session_id
                      for s in ws.list_sessions())
    if op == "profile_of":
        return ws.get_session(step["session"]).profile
    if op == "hides":
        session = ws.get_session(step["session"])
        hidden = session.hidden_paths
        return {
            "paths":
            sorted(hidden.paths) if hidden else [],
            "patterns":
            sorted(hidden.patterns) if hidden else [],
            "shown":
            sorted(e.path for e in session.shown_paths.entries)
            if session.shown_paths else [],
            "vars":
            sorted(session.hidden_vars.names) if session.hidden_vars else [],
        }
    if op == "decisions":
        return [{
            "outcome": None if d.outcome is None else d.outcome.value,
            "scope": None if d.scope is None else d.scope.value,
            "reason": d.rule.reason,
        } for d in ws.decisions.list(step["session"])]
    if op == "clis":
        return sorted(ws.clis())
    if op == "mounts":
        return sorted(m.prefix for m in ws.mounts())
    if op == "policies":
        return sorted(ws.policies.names())
    if op == "runtimes":
        return [r.name for r in ws.runtime_entries]
    if op == "env":
        return {k: v for k, v in sorted(ws.env.items())}
    if op == "live_only":
        return sorted((manifest or {}).get(StateKey.LIVE_ONLY_MOUNTS) or [])
    if op == "fingerprints":
        rows = (manifest or {}).get(StateKey.FINGERPRINTS) or []
        return sorted({str(r.get("path")) for r in rows})
    if op == "absent":
        return absent(step["literals"], literals, manifest)
    raise ValueError(f"unknown snapshot verify op: {op}")


def absent(wanted: list[str], literals: dict[str, str],
           manifest: dict[str, Any] | None) -> list[str]:
    """The literals a manifest must not spell, and whether it does.

    A snapshot is the deployment's document with its secrets redacted,
    so the check is on the serialized state rather than on any one
    config field: an alias resource records its own config under its
    parent's type, which is how a redaction check keyed on a class's
    field names missed one.

    Args:
        wanted (list[str]): the literals, ``${VAR}`` read from the
            environment and a per-run credential by name.
        literals (dict[str, str]): this run's own credentials.
        manifest (dict[str, Any] | None): the loaded state or None.
    """
    if manifest is None:
        return []
    # Bytes are decoded rather than skipped: a credential a resource
    # wrote into its own content would otherwise walk past the check.
    text = json.dumps(manifest, default=_readable)
    found: list[str] = []
    for raw in wanted:
        needle = raw
        if raw.startswith("${") and raw.endswith("}"):
            needle = os.environ.get(raw[2:-1], "")
        needle = literals.get(needle, needle)
        if needle and needle in text:
            found.append(raw)
    return found


def _readable(value: Any) -> str:
    """Anything a state dict holds, as text an ``absent`` scan can read.

    Args:
        value (Any): a value ``json.dumps`` cannot encode.
    """
    if isinstance(value, bytes):
        return value.decode("latin-1")
    return str(value)


def check(step: dict[str, Any], got: dict[str, Any]) -> None:
    """Fail a step whose own expectation the observation misses.

    Args:
        step (dict[str, Any]): the step document.
        got (dict[str, Any]): what the step observed.

    Raises:
        AssertionError: an expectation the observation does not meet.
    """
    for key, want in (step.get("expect") or {}).items():
        field = key.removesuffix("_contains")
        actual = got.get(field)
        if key.endswith("_contains"):
            if not isinstance(actual, str) or want not in actual:
                raise AssertionError(
                    f"{step['command']!r}: {field} does not contain "
                    f"{want!r}: {actual!r}")
        elif actual != want:
            raise AssertionError(f"{step['command']!r}: {field} is "
                                 f"{actual!r}, expected {want!r}")


def missing(case: dict[str, Any], root: Path) -> list[str]:
    """The service environment variables this case needs and lacks.

    Args:
        case (dict[str, Any]): the case document.
        root (Path): the integ corpus root.
    """
    services = harness.load_services(root)
    return harness.missing_env(services, case["target"], "python")


async def write_arm(run: str, out: Path, only: str | None) -> int:
    """Build each world, record it, and leave a tar beside the record.

    Args:
        run (str): the run id this arm's fakes are scoped to.
        out (Path): where the tars and records land.
        only (str | None): one case id, or None for all of them.
    """
    root = harness.integ_root()
    suite = json.loads(SUITE.read_text())
    failures = 0
    out.mkdir(parents=True, exist_ok=True)
    for case in suite["cases"]:
        cid = case["id"]
        if only is not None and cid != only:
            continue
        gaps = missing(case, root)
        if gaps:
            print(f"skip {HOST}/write/{cid}: needs {', '.join(gaps)}")
            (out / f"{cid}.skip").write_text(",".join(gaps))
            continue
        try:
            await write_one(case, f"{run}-{cid}", out, root)
        except Exception as exc:  # noqa: BLE001  (one arm, one report)
            failures += 1
            print(f"FAIL {HOST}/write/{cid}: {type(exc).__name__}: {exc}")
            if os.environ.get("SNAP_TRACE"):
                import traceback
                traceback.print_exc()
        else:
            print(f"ok {HOST}/write/{cid}")
    return failures


async def write_one(case: dict[str, Any], run_id: str, out: Path,
                    root: Path) -> None:
    """One world written to a tar, with its observations beside it.

    Args:
        case (dict[str, Any]): the case document.
        run_id (str): this case's own run id.
        out (Path): the output directory.
        root (Path): the integ corpus root.
    """
    ws, cleanup = await build(case, run_id, sessions=True)
    tar = out / f"{case['id']}.tar"
    try:
        for mount in case["target"]["mounts"]:
            await harness.seed_fixture(ws, mount.get("fixture"), mount["path"],
                                       root)
        await observe(ws, case.get("seed") or [], {}, None)
        # After the seed: a coded policy that refuses a path would
        # otherwise refuse the write that puts the path there.
        for rule in case.get("policies") or []:
            ws.policies.add(RulePolicy(rule))
        await ws.snapshot(str(tar))
        seen = await observe(ws, case["verify"], {}, read_manifest(tar))
    finally:
        await cleanup()
    (out / f"{case['id']}.{HOST}.json"
     ).write_text(json.dumps(seen, indent=2, sort_keys=True) + "\n")


def read_manifest(tar: Path) -> dict[str, Any]:
    """The state a tar carries, as the loader reads it.

    Args:
        tar (Path): the snapshot.
    """
    from mirage.workspace.snapshot.tar_io import read_tar
    return read_tar(str(tar))


async def read_arm(run: str, src: Path, out: Path, only: str | None) -> int:
    """Load the other arm's tars into fresh worlds and record what lands.

    Args:
        run (str): the run id this arm's fakes are scoped to.
        src (Path): where the other arm left its tars.
        out (Path): where this arm's records land.
        only (str | None): one case id, or None for all of them.
    """
    root = harness.integ_root()
    suite = json.loads(SUITE.read_text())
    failures = 0
    out.mkdir(parents=True, exist_ok=True)
    for case in suite["cases"]:
        cid = case["id"]
        if only is not None and cid != only:
            continue
        tar = src / f"{cid}.tar"
        if not tar.exists():
            print(f"skip {HOST}/read/{cid}: the writing arm left no tar")
            continue
        gaps = missing(case, root)
        if gaps:
            print(f"skip {HOST}/read/{cid}: needs {', '.join(gaps)}")
            continue
        try:
            await read_one(case, f"{run}-{cid}", tar, out, root)
        except Exception as exc:  # noqa: BLE001  (one arm, one report)
            failures += 1
            print(f"FAIL {HOST}/read/{cid}: {type(exc).__name__}: {exc}")
            if os.environ.get("SNAP_TRACE"):
                import traceback
                traceback.print_exc()
        else:
            print(f"ok {HOST}/read/{cid}")
    return failures


async def read_one(case: dict[str, Any], run_id: str, tar: Path, out: Path,
                   root: Path) -> None:
    """One tar loaded into a world this arm built and seeded itself.

    The world is this arm's own, which is the whole point: a snapshot
    carries content for the resources that hold it (RAM and redis
    restore through ``load_state``) and a fingerprint for the ones that
    do not, so an object store the reader seeded from the same fixture
    matches by construction and a live-only mount is read live. The
    resources the loader is handed are the ones this world just built,
    since a redacted config cannot be rebuilt from the tar.

    Args:
        case (dict[str, Any]): the case document.
        run_id (str): this case's own run id.
        tar (Path): the other arm's snapshot.
        out (Path): the output directory.
        root (Path): the integ corpus root.
    """
    host, cleanup = await build(case, run_id, sessions=False)
    try:
        for mount in case["target"]["mounts"]:
            await harness.seed_fixture(host, mount.get("fixture"),
                                       mount["path"], root)
        resources = {m.prefix: m.resource for m in host.mounts()}
        # An account CLI's config is redacted in the tar, so the loader
        # is handed the live one this world just built. A script CLI
        # needs its whole spec swapped instead: the tar carries the
        # writing host's program, which names a runtime this host does
        # not have, and a `(spec, config)` override is the door for it.
        clis: dict[str, Any] = {
            name: install.config
            for name, install in host.clis().items()
            if install.config is not None
        }
        swap = script_cli_spec(case)
        if swap is not None:
            clis[swap.name] = (swap, None)
        load = case.get("load") or {}
        drift = (DriftPolicy.OFF
                 if load.get("drift") == "off" else DriftPolicy.STRICT)
        ws = await Workspace.load(
            str(tar),
            resources=resources,
            clis=clis or None,
            profiles=profile_documents(case),
            policies=[RulePolicy(r) for r in (case.get("policies") or [])]
            if load.get("policies") else None,
            runtimes=[RUNTIME] if load.get("runtimes") else None,
            drift_policy=drift)
        try:
            if load.get("script_cli"):
                install_script_cli(ws, case)
            await ws.ensure_sessions_loaded()
            seen = await observe(ws, case["verify"], {}, read_manifest(tar))
        finally:
            await ws.close()
    finally:
        await cleanup()
    (out / f"{case['id']}.{HOST}.json"
     ).write_text(json.dumps(seen, indent=2, sort_keys=True) + "\n")


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("write", "read"))
    parser.add_argument("run")
    parser.add_argument("dir")
    parser.add_argument("--out", default=None)
    parser.add_argument("--case", default=None)
    args = parser.parse_args()
    where = Path(args.dir)
    if args.mode == "write":
        return await write_arm(args.run, where, args.case)
    out = Path(args.out) if args.out else where
    return await read_arm(args.run, where, out, args.case)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
