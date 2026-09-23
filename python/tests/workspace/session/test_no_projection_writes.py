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

REPO = Path(__file__).resolve().parents[4]

# `SessionState.env` / `.arrays` / `.readonly_vars` are read-only projections
# of the variable records (MappingProxyType in python, Object.freeze in
# TypeScript), so a write into one raises at runtime rather than landing.
# Writers go through `seed_var`/`seedVar`, `set_attr`/`setAttr`, or the
# `env` setter.
#
# Those three are the *ungated* doors and this test does not claim
# otherwise: the gate is `SessionView.set`/`.mark`, and anything a line
# the agent typed can reach has to use it. What this test pins is
# narrower and still worth pinning, because it is a silent failure the
# other one is not: a write into a projection lands in a throwaway
# mapping (or raises, once the projection was frozen), so the value is
# simply lost.
#
# This is a meta-test rather than a type rule because the code that keeps
# getting it wrong is exactly the code no type checker sees: mypy runs on
# `mirage/` alone (`packages = ["mirage"]` in pyproject, and the hook is
# gated on `^python/mirage/`), so `integ/` and `tests/` are invisible to
# it, and that is where all of the last batch lived -- two runners and
# three state_store writes, none of which ran often enough to be caught
# by their own exception.
PY_PATTERNS = (
    re.compile(r"\.env\.(update|pop|setdefault|clear)\s*\("),
    re.compile(r"\.env\[[^\]]+\]\s*=[^=]"),
    re.compile(r"\.arrays\.(update|pop|setdefault|clear)\s*\("),
    re.compile(r"\.arrays\[[^\]]+\]\s*=[^=]"),
)
TS_PATTERNS = (
    re.compile(r"Object\.assign\(\s*[A-Za-z_][\w.]*\.(env|arrays)\b"),
    re.compile(r"(?<!process)\.env\.[A-Za-z_]\w*\s*=[^=]"),
    re.compile(r"(?<!process)\.env\[[^\]]+\]\s*=[^=]"),
)

# `CommandOpts.env` is a plain dict copy handed to one command
# invocation (`env_snapshot` returns a fresh dict), so writing into it is
# writing into a throwaway and is exactly what these two tests assert.
ALLOWED = {
    "python/tests/workspace/test_state_doors.py",
    "typescript/packages/core/src/workspace/state_doors.test.ts",
}

SEARCH_ROOTS = ("python/mirage", "python/tests", "integ", "examples",
                "typescript/packages")


def _sources() -> list[Path]:
    out: list[Path] = []
    for root in SEARCH_ROOTS:
        base = REPO / root
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if path.suffix not in (".py", ".ts"):
                continue
            parts = set(path.parts)
            if parts & {"node_modules", "dist", ".venv", "__pycache__"}:
                continue
            out.append(path)
    return out


def test_no_writes_into_the_read_only_projections() -> None:
    offenders: list[str] = []
    for path in _sources():
        rel = path.relative_to(REPO).as_posix()
        if rel in ALLOWED:
            continue
        patterns = PY_PATTERNS if path.suffix == ".py" else TS_PATTERNS
        for i, line in enumerate(path.read_text().splitlines(), 1):
            if any(p.search(line) for p in patterns):
                offenders.append(f"{rel}:{i}: {line.strip()}")
    assert not offenders, ("write into a read-only session projection; use "
                           "seed_var/seedVar, set_attr/setAttr or the `env` "
                           "setter instead:\n" + "\n".join(offenders))
