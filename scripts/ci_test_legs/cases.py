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

import dataclasses
from typing import Any

from audits import audit, audit_gates, audit_invocation, audit_packages

CORE = "@struktoai/mirage-core"
NODE = "@struktoai/mirage-node"
DSH = "@struktoai/mirage-dsh"
BOTH = {CORE, NODE}
AB = ["a", "b"]
MATRIX = {"node-version": ["24"], "leg": ["core", "cli"]}
LIVE = "pnpm run test:leg:${{ matrix.leg }}"


@dataclasses.dataclass(frozen=True, kw_only=True)
class Fixture:
    """A made-up repo and the refusal it has to produce.

    `expect` is the answer key: a substring the refusal must contain, or
    empty for a fixture the gate has to pass in silence.
    """

    name: str
    expect: str = ""

    def problems(self) -> list[str]:
        """Run the audit this fixture exercises.

        Returns:
            Every refusal the audit produced for this fixture.
        """
        raise NotImplementedError


@dataclasses.dataclass(frozen=True, kw_only=True)
class LegCase(Fixture):
    """A leg table, against the workspace it claims to cover.

    The defaults are the healthy two-leg repo, so a fixture spells out
    only what it breaks. `tested` is the packages that have a `test`
    script and `known` is every package that exists: a name in neither is
    a typo, one in `known` alone is a package that lost its script.
    """

    scripts: dict[str, str]
    declared: list[str] = dataclasses.field(default_factory=AB.copy)
    tested: set[str] = dataclasses.field(default_factory=BOTH.copy)
    known: set[str] = dataclasses.field(default_factory=BOTH.copy)

    def problems(self) -> list[str]:
        """Audit the leg table.

        Returns:
            Every refusal `audit` produced for this fixture.
        """
        return audit(self.scripts, self.declared, self.tested, self.known)


@dataclasses.dataclass(frozen=True, kw_only=True)
class GateCase(Fixture):
    """Matrix include rows, against the steps whose `if:` reads them."""

    include: list[dict[str, Any]]
    gated: dict[str, list[str]]

    def problems(self) -> list[str]:
        """Audit the include rows against the gated steps.

        Returns:
            Every refusal `audit_gates` produced for this fixture.
        """
        return audit_gates({**MATRIX, "include": self.include}, self.gated)


@dataclasses.dataclass(frozen=True, kw_only=True)
class InvocationCase(Fixture):
    """A `test` job, against the leg script it is supposed to run."""

    job: dict[str, Any]

    def problems(self) -> list[str]:
        """Audit the job's invocation of the selected leg.

        Returns:
            Every refusal `audit_invocation` produced for this fixture.
        """
        return audit_invocation(self.job)


@dataclasses.dataclass(frozen=True, kw_only=True)
class PackageCase(Fixture):
    """Workspace members, against whether each declares a `test` script."""

    members: dict[str, bool]

    def problems(self) -> list[str]:
        """Audit the members for a missing `test` script.

        Returns:
            Every refusal `audit_packages` produced for this fixture.
        """
        return audit_packages(self.members)


CLEAN = {"a": f"--filter {CORE} run test", "b": f"--filter {NODE} run test"}
LEG_CASES = (
    LegCase(name="clean table", scripts=CLEAN),
    LegCase(name="package claimed by no leg",
            scripts={"a": CLEAN["a"]},
            declared=["a"],
            expect="claimed by no leg"),
    LegCase(name="package claimed twice",
            scripts={
                **CLEAN, "b": f"--filter {CORE} --filter {NODE} run test"
            },
            expect="more than one leg"),
    LegCase(name="filter names a package that does not exist",
            scripts={
                **CLEAN, "a": f"{CLEAN['a']} --filter @struktoai/ghost"
            },
            expect="is not a workspace package"),
    LegCase(name="filter names a package that lost its test script",
            scripts={
                **CLEAN, "a": f"--filter {CORE} --filter {DSH} run test"
            },
            known=BOTH | {DSH},
            expect="declares no `test` script"),
    LegCase(name="script the matrix never runs",
            scripts=CLEAN,
            declared=["a"],
            expect="is never run"),
    LegCase(name="matrix leg with no script",
            scripts={"a": f"--filter {CORE} --filter {NODE} run test"},
            expect="has no test:leg:b"),
    LegCase(name="leg script runs the wrong verb",
            scripts={
                **CLEAN, "a": f"--filter {CORE} run build"
            },
            expect="not `test`"),
    LegCase(name="ellipsis selector",
            scripts={
                **CLEAN, "a": f"--filter {CORE}... run test"
            },
            expect="dependency closure"),
    LegCase(name="same package filtered twice in one leg",
            scripts={
                **CLEAN, "a": f"--filter {CORE} --filter {CORE} run test"
            },
            expect="more than once"),
    LegCase(name="--filter=name is read, not missed",
            scripts={
                **CLEAN, "a": f"--filter={CORE} run test"
            }),
    LegCase(name="a quoted name is read, not reported stale",
            scripts={
                "a": f"--filter '{CORE}' run test",
                "b": f'--filter "{NODE}" run test'
            }),
)

TYPECHECK = {"typecheck": ["Typecheck"]}
EXAMPLES = {"examples": ["Examples"]}
GATE_CASES = (
    GateCase(name="every gated key is set",
             include=[{
                 "leg": "cli",
                 "typecheck": True
             }],
             gated=TYPECHECK),
    GateCase(name="a gated key no include row sets",
             include=[],
             gated=EXAMPLES,
             expect="skipped on every leg"),
    GateCase(name="a gated key set to false",
             include=[{
                 "leg": "cli",
                 "typecheck": False
             }],
             gated=TYPECHECK,
             expect="falsy value"),
    GateCase(name="a gated key set to an empty string",
             include=[{
                 "leg": "cli",
                 "examples": ""
             }],
             gated=EXAMPLES,
             expect="falsy value"),
    GateCase(name="an include row for an undeclared leg",
             include=[{
                 "leg": "ghost",
                 "examples": True
             }],
             gated=EXAMPLES,
             expect="matches no declared leg"),
)

DEAD = "no step runs"
INVOCATION_CASES = (
    InvocationCase(name="a step runs the selected leg",
                   job={"steps": [{
                       "run": LIVE
                   }]}),
    InvocationCase(name="no step runs any leg",
                   job={"steps": [{
                       "run": "pnpm -r build"
                   }]},
                   expect=DEAD),
    InvocationCase(name="a step hardcodes one leg",
                   job={"steps": [{
                       "run": "pnpm run test:leg:core"
                   }]},
                   expect=DEAD),
    InvocationCase(name="the step is allowed to fail",
                   job={"steps": [{
                       "run": LIVE,
                       "continue-on-error": True
                   }]},
                   expect=DEAD),
    InvocationCase(name="the step is turned off with if: false",
                   job={"steps": [{
                       "run": LIVE,
                       "if": False
                   }]},
                   expect=DEAD),
    InvocationCase(name="the step is turned off with ${{ false }}",
                   job={"steps": [{
                       "run": LIVE,
                       "if": "${{ false }}"
                   }]},
                   expect=DEAD),
    InvocationCase(name="the leg is only named in a comment",
                   job={"steps": [{
                       "run": f"# {LIVE}\necho skipped"
                   }]},
                   expect=DEAD),
    InvocationCase(name="the leg is only echoed, not run",
                   job={"steps": [{
                       "run": f'echo "{LIVE}"'
                   }]},
                   expect=DEAD),
    InvocationCase(name="the whole job is allowed to fail",
                   job={
                       "continue-on-error": True,
                       "steps": [{
                           "run": LIVE
                       }]
                   },
                   expect="continue-on-error: true"),
)

PACKAGE_CASES = (
    PackageCase(name="every package has a test",
                members={
                    "a": True,
                    "b": True
                }),
    PackageCase(name="a package with no test script",
                members={
                    "a": True,
                    "b": False
                },
                expect="declares no `test` script"),
)

GROUPS: tuple[tuple[str, tuple[Fixture, ...]], ...] = (
    ("leg table", LEG_CASES),
    ("matrix gates", GATE_CASES),
    ("invocation", INVOCATION_CASES),
    ("packages", PACKAGE_CASES),
)
