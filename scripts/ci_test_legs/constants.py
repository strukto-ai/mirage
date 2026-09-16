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

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github/workflows/test_typescript.yml"
TS_ROOT = REPO / "typescript"
ROOT_MANIFEST = TS_ROOT / "package.json"
PACKAGES = TS_ROOT / "packages"
LEG_PREFIX = "test:leg:"
FILTER = re.compile(r"--filter(?:=|\s+)(\S+)")
MATRIX_REF = re.compile(r"matrix\.([A-Za-z_][A-Za-z0-9_-]*)")

NO_MATRIX = ("{file}: no jobs.test.strategy.matrix (stopped at {key!r}); the "
             "job or its matrix was renamed, and this gate cannot see the leg "
             "table any more")
NO_LEG_DIM = ("{file}: jobs.test.strategy.matrix has no `leg` dimension; this "
              "gate cannot see the leg table any more")
NO_TEST_SCRIPT = ("{name} declares no `test` script; the root `test` script "
                  "selects ./packages/* and pnpm.requiredScripts lists "
                  "`test`, so this breaks `pnpm test` for everyone as well as "
                  "going unclaimed by any leg")
JOB_MAY_FAIL = ("the `test` job is `continue-on-error: true`, so every leg "
                "reports success whatever its tests do and "
                "test-typescript-gate goes green over a red run")
NO_LIVE_STEP = ("no step runs `{wanted}` on a live line that can fail the "
                "job; a step that is absent, `if: false`, "
                "`continue-on-error: true` or only mentions it in a comment "
                "all leave the legs selected by the matrix and then never "
                "invoked")
STRAY_INCLUDE = ("include row for leg {leg!r} matches no declared leg "
                 "({legs}); GitHub cannot merge it into a combination, so it "
                 "becomes a spurious extra job and the leg it was meant for "
                 "loses {lost}")
FALSY_GATE = ("include sets `{key}: {value!r}` on {where}; a falsy value "
              "gates nothing, so every step behind `if: matrix.{key}` is "
              "skipped on every leg and the run still reports green")
UNSET_GATE = ("step(s) {steps} run only `if: matrix.{key}`, which no include "
              "row sets, so they are skipped on every leg and the run still "
              "reports green")
NO_LEG_SCRIPT = ("matrix leg {leg!r} has no {prefix}{leg} script in "
                 "typescript/package.json; the job would fail on the runner "
                 "with pnpm's \"Missing script\"")
WRONG_VERB = ("{prefix}{leg} runs {ran!r}, not `test`; it would select the "
              "right packages and run the wrong script, and pnpm's "
              "requiredScripts only guards the `test` verb it never reaches")
SCRIPT_UNUSED = ("script {prefix}{leg} is never run: {leg!r} is absent from "
                 "the matrix leg list, so every package it claims is tested "
                 "by nobody")
CLOSURE_FILTER = ("leg {leg!r} filters {token!r}: a `...` selector pulls the "
                  "dependency closure back into the leg and re-serialises "
                  "what the split exists to remove")
DOUBLE_FILTER = "leg {leg!r} filters {name!r} more than once"
BAD_PACKAGE = "leg(s) {legs} filter {name!r}, which {why}"
NO_TEST_WHY = "exists but declares no `test` script"
UNKNOWN_WHY = "is not a workspace package"
DOUBLE_CLAIM = ("{name} is claimed by more than one leg ({legs}), so its "
                "tests run twice")
UNCLAIMED = "{name} is claimed by no leg, so CI never runs its tests"
