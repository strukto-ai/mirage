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

import pathlib

TESTS = pathlib.Path(__file__).resolve().parent
SOURCE = TESTS.parent / "mirage"
IGNORED = {"__pycache__", ".pytest_cache"}

# A test directory earns its place by mirroring a source package, so that a
# reader can go from `mirage/<pkg>/` to `tests/<pkg>/` without guessing. These
# eight mirror nothing on purpose: they hold harnesses and fixture data rather
# than a suite for one source package. Every other test directory must have a
# twin -- `tests/resource/object_storage/` is what this rule is for, because it
# collected 24 suites for 19 sibling packages and made `mirage/resource/s3/`
# look untested.
UNMIRRORED_DIRS = {
    "commands/builtin/jq":
    "the embedded jq engine spans generic/jq.py and its builder; the "
    "suite is grouped per feature, not per module",
    "commands/custom":
    "exercises the public command-registration API, not a package",
    "commands/native":
    "the native-binary harness: each case runs a real coreutils binary "
    "and diffs mirage against it",
    "config":
    "loader tests plus the bad-config YAML shared with the TypeScript tree",
    "config/fixtures":
    "the YAML files themselves",
    "conformance":
    "runs the cross-language cases under the top-level conformance/ tree",
    "e2e":
    "end-to-end suites that span the package, so no one source dir owns "
    "them",
    "fixtures":
    "shared test doubles imported by suites elsewhere",
}

# A ratchet, not a target. It counts source modules with no `test_<name>.py`
# anywhere under tests/ -- the weaker of the two readings, because CLAUDE.md
# asks for a mirror only "where reasonable" and several suites deliberately
# cover a family in one file. Moving it in either direction is a deliberate
# act: adding a module with no test raises it, and closing a gap has to be
# locked in by lowering it.
#
# Known blind spot, and the reason this number is a floor rather than a
# measure of coverage: the match is by basename, so seven unrelated
# `test_history.py` files make every `history.py` in the tree look
# mirrored. Reading it strictly -- a test beside its own source twin --
# would count 816 today. What the ratchet buys is narrower than it looks:
# a module whose name appears nowhere in the suite cannot be added
# silently.
MIRROR_BASELINE = 174


def _test_dirs() -> list[pathlib.Path]:
    return [
        d for d in sorted(TESTS.rglob("*"))
        if d.is_dir() and not IGNORED & set(d.parts)
    ]


def _source_modules() -> list[pathlib.Path]:
    return [
        p.relative_to(SOURCE) for p in sorted(SOURCE.rglob("*.py"))
        if not IGNORED & set(p.parts) and p.name != "__init__.py"
    ]


def test_tests_declare_no_packages():
    """`tests/` is a namespace tree; pytest imports it without __init__.py.

    `pyproject.toml` sets `--import-mode=importlib`, which already resolves
    the same-basename collisions (34 different `test_find.py`) that an
    `__init__.py` would otherwise be needed for. CLAUDE.md forbids them
    outright, and without a check the count reached 87.
    """
    found = sorted(
        str(p.relative_to(TESTS)) for p in TESTS.rglob("__init__.py")
        if not IGNORED & set(p.parts))
    assert not found, ("tests/ is a namespace tree -- delete these:\n" +
                       "\n".join(found))


def test_every_test_directory_mirrors_a_source_package():
    """Each test directory maps to a `mirage/` package, or is exempt above."""
    missing = [
        rel for rel in (str(d.relative_to(TESTS)) for d in _test_dirs())
        if not (SOURCE / rel).is_dir() and rel not in UNMIRRORED_DIRS
    ]
    assert not missing, (
        "these test directories mirror no mirage/ package -- move them onto "
        "the source layout, or add them to UNMIRRORED_DIRS with a reason:\n" +
        "\n".join(f"  tests/{rel}" for rel in sorted(missing)))


def test_no_stale_directory_exemption():
    """An exemption outlives its reason silently; make it fail instead."""
    stale = []
    for rel, reason in UNMIRRORED_DIRS.items():
        if not (TESTS / rel).is_dir():
            stale.append(f"  {rel}: gone ({reason})")
        elif (SOURCE / rel).is_dir():
            stale.append(f"  {rel}: mirage/{rel} exists now ({reason})")
    assert not stale, ("drop these entries from UNMIRRORED_DIRS:\n" +
                       "\n".join(stale))


def test_module_mirror_coverage_holds_the_baseline():
    """Ratchet the number of source modules that no test file is named for."""
    named = {p.name for p in TESTS.rglob("test_*.py")}
    unmirrored = [
        m for m in _source_modules() if f"test_{m.stem}.py" not in named
    ]
    count = len(unmirrored)
    if count > MIRROR_BASELINE:
        added = "\n".join(f"  mirage/{m}" for m in unmirrored[:20])
        raise AssertionError(
            f"{count} source modules have no test named for them, above the "
            f"baseline of {MIRROR_BASELINE}. Add `test_<module>.py` beside "
            f"its source twin. Some of the modules counted:\n{added}")
    assert count == MIRROR_BASELINE, (
        f"mirror coverage improved to {count}; lock it in by setting "
        f"MIRROR_BASELINE = {count}")
