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

import json
import math
import os
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from mirage.policy import Scope
from mirage.policy.match import Outcome
from mirage.types import FileStat, PathSpec

# integ/runtime holds the runtime suite (its own schema and runners,
# integ/runtime/run.{py,ts} + cli.sh), not battery cases; keep it out.
CASE_DIRS = ("unix", "bash", "crossmount", "resources", "cli", "session",
             "console", "secrets")


def integ_root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_targets(root: Path) -> dict:
    data = json.loads((root / "targets.json").read_text())
    return {t["id"]: t for t in data["targets"]}


def load_services(root: Path) -> dict:
    """The service -> per-host required env vars table.

    An empty list means the host needs nothing because its adapter starts
    an in-process fake; the two hosts differ here (python self-hosts s3,
    ssh, hf, box, databricks, discord, linear and dify, typescript does
    not), so the asymmetry is spelled out per host rather than inferred.

    Args:
        root (Path): the integ directory.

    Returns:
        dict: service name -> {"python": [...], "typescript": [...]}.
    """
    return validate_services(json.loads((root / "targets.json").read_text()))


def validate_services(data: dict) -> dict:
    """Reject a services table that has drifted from the target list.

    Args:
        data (dict): the parsed targets.json.

    Returns:
        dict: the validated services table.
    """
    services = data["services"]
    named = {t["service"] for t in data["targets"] if t.get("service")}
    undeclared = sorted(named - set(services))
    if undeclared:
        raise KeyError(f"targets.json: services missing an entry: "
                       f"{', '.join(undeclared)}")
    unused = sorted(set(services) - named)
    if unused:
        raise KeyError(f"targets.json: services entry names no target: "
                       f"{', '.join(unused)}")
    for name, hosts in services.items():
        if set(hosts) != {"python", "typescript"}:
            raise KeyError(f"targets.json: service {name!r} must declare "
                           f"both 'python' and 'typescript'")
    return services


def parse_allow_skip(services: dict, value: str) -> set[str]:
    """Service names a caller declares it knowingly does not provision.

    Rejects a name that is not a real service so the list cannot rot into
    a typo that quietly widens what --strict tolerates.

    Args:
        services (dict): the table from load_services.
        value (str): comma-separated service names, possibly empty.

    Returns:
        set[str]: the declared service names.
    """
    names = {n.strip() for n in value.split(",") if n.strip()}
    unknown = sorted(names - set(services))
    if unknown:
        raise KeyError(f"--allow-skip names unknown service(s): "
                       f"{', '.join(unknown)}")
    return names


def missing_env(services: dict, target: dict, host: str) -> list[str]:
    """Env vars this host needs for this target and does not have.

    Args:
        services (dict): the table from load_services.
        target (dict): a target entry.
        host (str): "python" or "typescript".

    Returns:
        list[str]: unset variable names, empty when the target can run.
    """
    service = target.get("service")
    if service is None:
        return []
    return [v for v in services[service][host] if not os.environ.get(v)]


def discover_case_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for name in CASE_DIRS:
        files.extend(sorted((root / name).rglob("*.json")))
    return files


def load_cases(root: Path) -> list[dict]:
    cases: list[dict] = []
    for path in discover_case_files(root):
        data = json.loads(path.read_text())
        for case in data["cases"]:
            case["_source"] = str(path.relative_to(root))
            cases.append(case)
    cases.sort(key=lambda c: c.get("seq", 1 << 30))
    validate_cases(root, cases)
    return cases


def validate_cases(root: Path, cases: list[dict]) -> None:
    """Fail loudly on the two ways a case silently stops being tested.

    A duplicate id collides in the parity runner, which keys rows by
    (target, id), so one of the pair is dropped from the py/ts diff
    without a word. A target id that matches no manifest entry means the
    case never runs anywhere, which reads as "passing" everywhere.

    Args:
        root (Path): the integ directory.
        cases (list[dict]): every loaded case.
    """
    known = set(load_targets(root))
    seen: dict[str, str] = {}
    duplicates: list[str] = []
    unknown: list[str] = []
    for case in cases:
        first = seen.get(case["id"])
        if first is not None:
            duplicates.append(f"{case['id']} ({first} and {case['_source']})")
        else:
            seen[case["id"]] = case["_source"]
        for target in case["targets"]:
            if target not in known:
                unknown.append(f"{case['id']} -> {target}"
                               f" ({case['_source']})")
    if duplicates:
        raise ValueError("duplicate case ids: " + "; ".join(duplicates))
    if unknown:
        raise ValueError("cases naming an unknown target: " +
                         "; ".join(unknown))


def build_fixture(
        base: Path) -> tuple[Path, tempfile.TemporaryDirectory
                             | None]:
    """Where a fixture's files are, building them first if it says to.

    A fixture holding a ``build.sh`` generates its own contents into a
    temporary directory instead of shipping them. Only git needs this
    so far, and it needs it absolutely: a repository cannot hold another
    repository's ``.git``, because ``git add`` silently refuses any path
    with a ``.git`` component, so a checked-in tree would look staged
    and never be. Generating also keeps the fixture readable as a script
    rather than as zlib blobs.

    Args:
        base (Path): the fixture directory under integ/fixtures.
    """
    script = base / "build.sh"
    if not script.is_file():
        return base, None
    holder = tempfile.TemporaryDirectory(prefix="integ-fixture-")
    built = Path(holder.name) / "root"
    subprocess.run([str(script), str(built)], check=True)
    return built, holder


async def seed_fixture(ws, fixture: str | None, mount_path: str,
                       root: Path) -> None:
    if not fixture:
        return
    base, holder = build_fixture(root / "fixtures" / fixture)
    try:
        for src in sorted(base.rglob("*")):
            if not src.is_file():
                continue
            rel = src.relative_to(base).as_posix()
            dest = f"{mount_path.rstrip('/')}/{rel}"
            parent = dest.rsplit("/", 1)[0]
            await ws.execute(f"mkdir -p {parent}")
            await ws.execute(f"tee {dest} > /dev/null", stdin=src.read_bytes())
    finally:
        if holder is not None:
            holder.cleanup()


async def seed_mount_root(ws, mount_path: str) -> None:
    """Materialise a fixtureless mount's backing folder on the service.

    Prefix-scoped object stores treat an absent prefix as an empty
    directory, and the gws adapter pre-creates each mount's root folder
    chain, but folder-backed services (dropbox, sharepoint) 404 when a
    mount roots at a folder nothing ever created. Writing and removing a
    marker file rides the same workspace plumbing fixture seeding uses:
    the upload auto-creates the folder chain and the delete leaves the
    folders behind, so the mount lists as empty like every other target.

    Args:
        ws: the target workspace.
        mount_path (str): the mount to materialise.
    """
    marker = f"{mount_path.rstrip('/')}/.seed"
    await ws.execute(f"tee {marker} > /dev/null", stdin=b"seed\n")
    await ws.execute(f"rm {marker}")


def _check_field(st: FileStat, name: str) -> str:
    if name == "mode":
        value = oct(st.mode)[2:] if st.mode is not None else "-"
    elif name == "uid":
        value = str(st.uid) if st.uid is not None else "-"
    elif name == "gid":
        value = str(st.gid) if st.gid is not None else "-"
    else:
        # First 19 chars ("2026-01-02T15:30:00") so the Z vs +00:00 suffix
        # never reaches the comparison.
        value = st.modified[:19] if st.modified else "-"
    return f"{name}={value}"


async def stat_check(ws, check: dict) -> str:
    """The probe a case runs beside its command, as one printable line.

    Two forms. ``stat`` names a path and the FileStat fields to print.
    ``read`` names a path and a byte window, and prints what that window
    returned: no shell command asks for one, because commands read whole
    files, so the ranged read op is only reachable through the same door
    FUSE and the ops facade use.

    Args:
        ws: the workspace the case runs against.
        check (dict): the case's ``check`` block.
    """
    if "read" in check:
        data, _ = await ws.dispatch("read",
                                    PathSpec.from_str_path(check["read"]),
                                    offset=check.get("offset", 0),
                                    size=check.get("size"))
        return data.decode("utf-8", "replace")
    try:
        st, _ = await ws.dispatch("stat",
                                  PathSpec.from_str_path(check["stat"]))
    except FileNotFoundError:
        return "absent\n"
    line = " ".join(_check_field(st, name) for name in check["fields"])
    return line + "\n"


def provision_line(result) -> str:
    return (f"net={result.network_read} write={result.network_write} "
            f"cache={result.cache_read} ops={result.read_ops} "
            f"hits={result.cache_hits} precision={result.precision.value}")


def bind_mount(case: dict, mount_path: str) -> dict:
    """Substitute {mount} and {http} in a case with run-time values.

    {mount} lets one case assert a behavior that every backend shares while
    each target keeps its own mount path. {http} carries the fixture HTTP
    server's base URL, which is only known once the server has bound a port.
    Cases without a token are returned untouched, so this is inert for the
    existing suite.

    Args:
        case (dict): case as loaded from disk.
        mount_path (str): the target's primary mount path.

    Returns:
        dict: the case with the tokens replaced in command and expectations.
    """
    tokens = {
        "{mount}": mount_path.rstrip("/"),
        "{http}": os.environ.get("HTTP_ENDPOINT", ""),
    }
    encoded = json.dumps(case)
    tokens = {t: v for t, v in tokens.items() if t in encoded}
    if not tokens:
        return case
    bound = dict(case)
    if "command" in bound:
        for token, value in tokens.items():
            bound["command"] = bound["command"].replace(token, value)
    check = bound.get("check")
    if isinstance(check, dict):
        bound["check"] = dict(check)
        for name in ("stat", "read"):
            if isinstance(check.get(name), str):
                for token, value in tokens.items():
                    bound["check"][name] = bound["check"][name].replace(
                        token, value)
    expect = dict(bound["expect"])
    for name in ("stdout", "stderr", "check"):
        if isinstance(expect.get(name), str):
            for token, value in tokens.items():
                expect[name] = expect[name].replace(token, value)
    bound["expect"] = expect
    return bound


class Answer(StrEnum):
    """The battery's word for a host answer.

    Deliberately not the library's vocabulary: a case says one word
    where the workspace takes an outcome and a scope, so the pairing
    lives in ANSWERS rather than in every case file.
    """

    ALLOW_ONCE = "allow_once"
    ALLOW_SESSION = "allow_session"
    DENY = "deny"


# What each word answers with. DENY is ONCE because a refusal answers
# the one retry it was given for; a session-wide deny would be a rule,
# which is the document's job and not a host's.
ANSWERS: dict[Answer, tuple[Outcome, Scope]] = {
    Answer.ALLOW_ONCE: (Outcome.ALLOW, Scope.ONCE),
    Answer.ALLOW_SESSION: (Outcome.ALLOW, Scope.SESSION),
    Answer.DENY: (Outcome.DENY, Scope.ONCE),
}


async def answer_decisions(ws, answer: str) -> None:
    """The host's side of the ask arm: answer every question waiting on
    the workspace the way the case says, so the command that follows
    finds the answer (or the refusal) the way an agent's retry would.
    How a case exercises the ask arm, since the battery has no host of
    its own.

    The word is resolved through the enum before anything is answered,
    so a case that misspells one fails loudly here. Reading it as an
    open string cost the opposite: every word that was not
    ``allow_once`` fell through to a session-wide allow, so a typo
    passed the case while testing the most permissive answer there is.

    Args:
        ws: the workspace the case runs against.
        answer (str): the case's word for every waiting record.

    Raises:
        ValueError: the case names a word outside the vocabulary.
    """
    outcome, scope = ANSWERS[Answer(answer)]
    for record in ws.decisions.pending():
        await ws.decisions.answer(record.id, outcome, scope)


async def predicted_refusal(ws, case: dict) -> tuple[int, str] | None:
    """What ``explain`` says would refuse this line, None when it says
    the line runs.

    The first refusal wins, because that is the one the run reports:
    a line is refused by its first refusing command.

    Args:
        ws: the workspace the case runs against.
        case (dict): the case as loaded from disk.
    """
    said = await ws.explain(case["command"], case.get("session") or "")
    for expl in said:
        if expl.exit_code != 0:
            return expl.exit_code, expl.stderr
    return None


def rule_reasons(doc: dict) -> tuple[str, ...]:
    """Every reason a document's rules can speak with.

    These are what a refusal the policy layer wrote looks like on the
    wire, and they are distinctive enough ("sealed until review") to
    tell one apart from an ordinary command failure, which is what
    ``explain_notes`` needs to check the direction a prediction cannot
    check on its own.

    Args:
        doc (dict): the target's permissions document.
    """
    found: list[str] = []
    stack: list[object] = [doc]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            reason = node.get("reason")
            if isinstance(reason, str):
                found.append(reason)
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return tuple(sorted(set(found)))


def explain_notes(predicted: tuple[int, str] | None, recorded: int,
                  exit_code: int, out: str, err: str,
                  reasons: tuple[str, ...]) -> list[str]:
    """Where the dry run and the run disagreed, empty when they agree.

    Three properties, checked against every policy case rather than only
    the unit tests, because each is a promise the whole surface makes and
    none of them is visible in a golden.

    A dry run must record no question, or a host fields requests for
    lines nobody typed. A refusal it predicts must be the refusal that
    arrives. And the harder direction: a refusal that arrives must have
    been predicted, which is checked by looking for one of the
    document's own rule reasons in what the run printed. That last one
    is the direction a prediction cannot check on its own, and it is
    where the bugs were: reading a line without its redirect target
    answered ALLOW for a line the run refused.

    The message is looked for on either stream because the line's own
    redirections still apply to the run and not to the prediction:
    ``rm /denied 2>&1`` is refused on stdout.

    Args:
        predicted (tuple[int, str] | None): what explain foresaw.
        recorded (int): questions the ledger gained during explain.
        exit_code (int): what the run exited with.
        out (str): the run's stdout.
        err (str): the run's stderr.
        reasons (tuple[str, ...]): every reason the document can speak
            with.
    """
    notes: list[str] = []
    if recorded:
        notes.append(
            f"explain: recorded {recorded} question(s), must record none")
    spoke = next((r for r in reasons if r and (r in err or r in out)), None)
    if predicted is None:
        if spoke is not None:
            notes.append(f"explain: said the line runs, but a rule refused it "
                         f"with {spoke!r}")
        return notes
    code, text = predicted
    if code != exit_code:
        notes.append(f"explain: predicted exit {code}, run exited {exit_code}")
    if text and text not in err and text not in out:
        notes.append(f"explain: predicted stderr {text!r}, run wrote {err!r}")
    return notes


async def run_case(
    ws, case: dict, reasons: tuple[str, ...] = ()
) -> tuple[int, str, str, float, str | None, list[str]]:
    """Run one case and return what it produced.

    The post-condition a case declares under ``check`` is returned beside
    stdout rather than in place of it, so a case can pin both what the
    command printed and what it left behind.

    Args:
        ws: the workspace the case runs against.
        case (dict): the case as loaded from disk.
        reasons (tuple[str, ...]): every reason the target's document
            can speak with; non-empty turns on the ``ws.explain``
            cross-check, which is worth its extra dry run only where a
            verdict exists to predict. A case whose verdict the command
            plane cannot reach says so in ``explain_blind`` and is left
            out, never silently.

    Returns:
        tuple: exit code, stdout, stderr, elapsed seconds, the stat line
        for the case's ``check`` (None when it declares none), and any
        notes on where the dry run disagreed with the run.
    """
    if case.get("clear_cache"):
        # A full clear means the file cache AND every mount's index cache:
        # remote listings live in the per-resource index, and a listing
        # populated by an earlier case must not leak into this one.
        # Resources without an index cache have nothing to clear.
        await ws.cache.clear()
        for mount in ws.mounts():
            store = getattr(mount.resource, "index", None)
            if store is not None:
                await store.clear()
    start = time.monotonic()
    if case.get("provision"):
        plan = await ws.execute(case["command"], provision=True)
        return 0, provision_line(
            plan) + "\n", "", time.monotonic() - start, None, []
    if case.get("answer") is not None:
        await answer_decisions(ws, case["answer"])
    predicted = None
    recorded = 0
    if reasons and not case.get("explain_blind"):
        before = len(ws.decisions.pending())
        predicted = await predicted_refusal(ws, case)
        # Counted here, not after the run: the run records its own
        # question, and charging that to the dry run would fail every
        # ask case.
        recorded = len(ws.decisions.pending()) - before
    result = await ws.execute(case["command"], session_id=case.get("session"))
    elapsed = time.monotonic() - start
    out = await result.stdout_str()
    err = await result.stderr_str()
    notes = (explain_notes(predicted, recorded, result.exit_code, out, err,
                           reasons)
             if reasons and not case.get("explain_blind") else [])
    check_out = None
    if case.get("check") is not None:
        check_out = await stat_check(ws, case["check"])
    return result.exit_code, out, err, elapsed, check_out, notes


async def run_scenario(read_ws, mutate, steps: list[dict]) -> tuple[int, str]:
    outs: list[str] = []
    exit_code = 0
    for step in steps:
        if "mutate" in step:
            spec = step["mutate"]
            await mutate(spec["path"], spec["content"].encode())
            continue
        result = await read_ws.execute(step["command"])
        outs.append(await result.stdout_str())
        exit_code = result.exit_code
    return exit_code, "".join(outs)


def compare(case: dict,
            exit_code: int,
            out: str,
            err: str,
            elapsed: float,
            check_out: str | None = None,
            notes: list[str] | None = None) -> list[str]:
    expect = case["expect"]
    diffs: list[str] = list(notes or [])
    if exit_code != expect["exit"]:
        diffs.append(f"exit: expected {expect['exit']}, got {exit_code}")
    if out != expect["stdout"]:
        diffs.append(f"stdout: expected {expect['stdout']!r}, got {out!r}")
    if err.rstrip("\n") != expect["stderr"].rstrip("\n"):
        diffs.append(f"stderr: expected {expect['stderr']!r}, got {err!r}")
    if case.get("check") is not None and check_out != expect["check"]:
        diffs.append(f"check: expected {expect['check']!r}, got {check_out!r}")
    bounds = expect.get("elapsed")
    if bounds is not None and not bounds["min"] <= elapsed <= bounds["max"]:
        diffs.append(f"elapsed: expected [{bounds['min']}, {bounds['max']}]"
                     f", got {elapsed:.3f}")
    return diffs


def _secs(value: float) -> str:
    return f"{value:.1f}s" if value >= 1 else f"{value * 1000:.0f}ms"


def _at(ordered: list[float], quantile: float) -> float:
    """Pick the sample at a quantile, the same way the TypeScript host does.

    ``floor(x + 0.5)`` rather than ``round``: python rounds a half to even
    and JS ``Math.round`` rounds it up, so an even sample count made the two
    hosts choose different indexes and report different percentiles for the
    same ordered data.

    Args:
        ordered (list[float]): samples, ascending.
        quantile (float): 0 to 1.

    Returns:
        float: the chosen sample.
    """
    index = math.floor(quantile * (len(ordered) - 1) + 0.5)
    return ordered[min(len(ordered) - 1, max(0, index))]


SCENARIO_VERB = "scenario"


def scenario_verb(case: dict) -> str:
    """Name the command a case runs, scenario cases included.

    A consistency case carries no ``command``: its commands live in the
    scenario steps, so reading the field straight off it labelled every one
    of them as unknown.

    Such a case is charged as ``scenario``, not as its first step. The
    interval is the whole case, and a scenario spends it on out-of-band
    remote writes and more than one invocation, so billing it to the first
    verb made ``cat`` and ``find`` carry time no ``cat`` or ``find`` spent.
    A row of its own says what the time is; the slowest-cases table above it
    is where an expensive one is named.

    Args:
        case (dict): the case being recorded.

    Returns:
        str: the command line to take a verb from, "scenario" for a scenario
            case, or "" when it has neither.
    """
    command = case.get("command")
    if isinstance(command, str):
        return command
    for step in case.get("scenario") or []:
        if isinstance(step, dict) and isinstance(step.get("command"), str):
            return SCENARIO_VERB
    return ""


# A leading `NAME=value` assignment, where the value may be quoted or a
# parenthesised array. Splitting on whitespace instead cut `v='a b'` in half
# and recorded the fragment as the command.
_LEADING_ASSIGN = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|\"[^\"]*\"|\([^)]*\)|\S*)\s*")
_LEADING_SEP = re.compile(r"^(?:;|&&|\|\||&)\s*")
# `out=$(cat <<END` is the command `cat`, but the assignment above ends at the
# space and leaves `<<END` as the first word. Tried before it, so the `\S*`
# arm never gets to swallow `$(cat`.
_LEADING_CMDSUB = re.compile(r"^(?:[A-Za-z_][A-Za-z0-9_]*=)?\$\(\s*")
# A subshell or brace group is a wrapper, not the command: `(cd d && grep x)`
# was recorded as `(cd`. Stripping the delimiter re-enters the loop, so
# `((echo a); echo b)` peels both. It does NOT make the row `grep`: knowing
# that `cd` is a prelude is shell semantics, and this labels a row rather
# than parsing a line.
_LEADING_GROUP = re.compile(r"^[({]\s*")


def command_verb(command: str) -> str:
    """Name the command a line runs, for grouping the profile.

    Not a shell parser, and it does not need to be: this only labels a row,
    so the cost of a wrong guess is a mislabelled row rather than a wrong
    measurement. It does handle the two shapes the corpus actually uses,
    a quoted assignment and a leading separator.

    Args:
        command (str): the case's shell line.

    Returns:
        str: the command name, or "?" when the line has none.
    """
    rest = command.strip()
    while rest:
        match = (_LEADING_CMDSUB.match(rest) or _LEADING_GROUP.match(rest)
                 or _LEADING_ASSIGN.match(rest) or _LEADING_SEP.match(rest))
        if match is None or match.end() == 0:
            break
        rest = rest[match.end():]
    words = rest.split()
    return words[0].rsplit("/", 1)[-1] if words else "?"


@dataclass
class Report:
    passed: int = 0
    failed: int = 0
    failures: list[str] = field(default_factory=list)
    stream: bool = True
    held: list[str] = field(default_factory=list)
    samples: list[tuple[str, str, float, str]] = field(default_factory=list)
    # Wall time for the whole target, which the per-case samples cannot see:
    # opening it, seeding fixtures and cleaning up all sit outside
    # ``run_case``, and on nextcloud the fixture seed alone is dozens of
    # remote writes.
    target_wall: dict[str, float] = field(default_factory=dict)

    def _say(self, line: str) -> None:
        if self.stream:
            print(line)
        else:
            self.held.append(line)

    def record(self,
               target: str,
               case_id: str,
               diffs: list[str],
               elapsed: float = 0.0,
               command: str = "") -> None:
        self.samples.append((target, case_id, elapsed, command_verb(command)))
        if diffs:
            self.failed += 1
            joined = "; ".join(diffs)
            self.failures.append(f"[{target}] {case_id}: {joined}")
            self._say(f"FAIL [{target}] {case_id}: {joined}")
        else:
            self.passed += 1
            self._say(f"ok   [{target}] {case_id}")

    def note_target_wall(self, target: str, seconds: float) -> None:
        """Add a target's whole-run wall time.

        Args:
            target (str): target id.
            seconds (float): wall time for opening, running and cleaning it up.
        """
        self.target_wall[target] = self.target_wall.get(target, 0.0) + seconds

    def absorb(self, other: "Report") -> None:
        self.passed += other.passed
        self.failed += other.failed
        self.failures.extend(other.failures)
        self.samples.extend(other.samples)
        for target, seconds in other.target_wall.items():
            self.note_target_wall(target, seconds)
        for line in other.held:
            print(line)

    def summary(self) -> str:
        return f"{self.passed} passed, {self.failed} failed"

    def profile(self, top: int = 15) -> str:
        """Where the battery's wall clock goes.

        Local timings do not carry to CI, so this reports from inside the
        CI job itself.

        Args:
            top (int): how many rows each ranked section prints.

        Returns:
            str: the formatted profile, empty when nothing was recorded.
        """
        if not self.samples:
            return ""
        # ``wall`` is the whole target, ``in cases`` is only what the cases
        # spent inside it. The gap between them is setup and teardown.
        out = ["", "=== profile: per target ==="]
        out.append(f"{'target':<22} {'cases':>6} {'wall':>9} {'in cases':>9} "
                   f"{'p50':>8} {'p90':>8} {'max':>9}")
        by_target: dict[str, list[float]] = {}
        for target, _case_id, elapsed, _verb in self.samples:
            by_target.setdefault(target, []).append(elapsed)
        # Ranked on ``wall``, the column this table exists to show. Ranking
        # on the case total instead buried a target whose cost is setup: 100s
        # of setup and 1s of cases sorted below a target with 2s of cases.
        for target, raw in sorted(
                by_target.items(),
                key=lambda kv: -self.target_wall.get(kv[0], sum(kv[1]))):
            ordered = sorted(raw)
            wall = self.target_wall.get(target, sum(raw))
            out.append(f"{target:<22} {len(raw):>6} {_secs(wall):>9} "
                       f"{_secs(sum(raw)):>9} "
                       f"{_secs(_at(ordered, 0.5)):>8} "
                       f"{_secs(_at(ordered, 0.9)):>8} "
                       f"{_secs(ordered[-1]):>9}")
        out += ["", f"=== profile: {top} slowest cases ==="]
        for target, case_id, elapsed, _verb in sorted(
                self.samples, key=lambda s: -s[2])[:top]:
            out.append(f"  {_secs(elapsed):>9}  [{target}] {case_id}")
        out += ["", f"=== profile: {top} costliest commands ==="]
        by_verb: dict[str, list[float]] = {}
        for _target, _case_id, elapsed, verb in self.samples:
            by_verb.setdefault(verb, []).append(elapsed)
        for verb, times in sorted(by_verb.items(),
                                  key=lambda kv: -sum(kv[1]))[:top]:
            mean = sum(times) / len(times)
            out.append(f"  {_secs(sum(times)):>9}  x{len(times):<5} "
                       f"mean {_secs(mean):>8}  {verb}")
        return "\n".join(out)
