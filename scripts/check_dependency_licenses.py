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
import concurrent.futures
import fnmatch
import json
import logging
import pathlib
import re
import sys
import time
import tomllib
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, TypeAlias

JsonValue: TypeAlias = (
    None
    | bool
    | int
    | float
    | str
    | list["JsonValue"]
    | dict[str, "JsonValue"]
)

logger = logging.getLogger(__name__)

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOCK = ROOT / "python/uv.lock"
EXCEPTIONS = ROOT / "licenses/dependency_exceptions.toml"
PROJECT = "mirage-ai"

# rust/deny.toml's list, plus the permissive licenses only the Python and
# npm trees use. A package passes when its license expression holds with
# these alone: one side of an OR, every side of an AND.
ALLOWED = frozenset(
    {
        "0BSD",
        "Apache-2.0",
        "Apache-2.0 WITH LLVM-exception",
        "BlueOak-1.0.0",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "bzip2-1.0.6",
        "CC0-1.0",
        "HPND",
        "ISC",
        "MIT",
        "MIT-0",
        "PSF-2.0",
        "Python-2.0",
        "Unicode-3.0",
        "Unlicense",
        "Zlib",
        "CNRI-Python",
        "MIT-CMU",
        "LicenseRef-BSD",
        "LicenseRef-Public-Domain",
    }
)

# A trove classifier's license, for a package whose metadata gives no
# SPDX expression. Several classifiers on one package are read as AND: a
# classifier never says whether the package offers a choice.
CLASSIFIERS = {
    "Apache Software License": "Apache-2.0",
    "BSD License": "LicenseRef-BSD",
    "ISC License (ISCL)": "ISC",
    "MIT License": "MIT",
    "MIT No Attribution License (MIT-0)": "MIT-0",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "Python Software Foundation License": "PSF-2.0",
    "The Unlicense (Unlicense)": "Unlicense",
    "zlib/libpng License": "Zlib",
    "Public Domain": "LicenseRef-Public-Domain",
    "Historical Permission Notice and Disclaimer (HPND)": "HPND",
    "Other/Proprietary License": "LicenseRef-Proprietary",
    "GNU General Public License (GPL)": "GPL-2.0-or-later",
    "GNU General Public License v2 (GPLv2)": "GPL-2.0-only",
    "GNU General Public License v3 (GPLv3)": "GPL-3.0-only",
    "GNU Lesser General Public License v2 (LGPLv2)": "LGPL-2.0-only",
    "GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0-only",
    "GNU Affero General Public License v3": "AGPL-3.0-only",
    "Eclipse Public License 2.0 (EPL-2.0)": "EPL-2.0",
}

# What package metadata writes for an SPDX id, case and spacing aside.
ALIASES = {
    "apache-2": "Apache-2.0",
    "bsd": "LicenseRef-BSD",
    "bsd-3": "BSD-3-Clause",
    "psf": "PSF-2.0",
}

# One-line License fields that name a license in words.
PROSE = {
    "3-Clause BSD License": "BSD-3-Clause",
    "Apache 2.0": "Apache-2.0",
    "Apache License 2.0": "Apache-2.0",
    "Apache License, Version 2.0": "Apache-2.0",
    "BSD 3-Clause OR Apache-2.0": "BSD-3-Clause OR Apache-2.0",
}

TOKEN = re.compile(r"\(|\)|[A-Za-z0-9.+:-]+")


@dataclass(frozen=True)
class Package:
    host: str
    name: str
    version: str
    license: str
    via: str


def spdx(word: str) -> str:
    return ALIASES.get(word.lower(), word)


def parse(expression: str) -> list[str] | None:
    """The expression as tokens, or None when it has a character no
    expression has.

    `WITH` is folded into the id it modifies, so `Apache-2.0 WITH
    LLVM-exception` is a single license.
    """
    words = TOKEN.findall(expression)
    if "".join(words) != re.sub(r"\s+", "", expression):
        return None
    tokens: list[str] = []
    for word in words:
        if tokens and tokens[-1] == "WITH":
            tokens.pop()
            tokens[-1] = f"{tokens[-1]} WITH {word}"
        else:
            tokens.append(word)
    return tokens


def evaluate(expression: str) -> tuple[bool, list[str]] | None:
    """Whether the allowed licenses alone satisfy `expression`, and the
    ids it names; None when it is not an SPDX expression.

    OR binds looser than AND, as SPDX reads them.
    """
    tokens = parse(expression)
    if not tokens:
        return None
    place = 0
    ids: list[str] = []

    def disjunction() -> bool:
        nonlocal place
        ok = conjunction()
        while place < len(tokens) and tokens[place].upper() == "OR":
            place += 1
            ok = conjunction() or ok
        return ok

    def conjunction() -> bool:
        nonlocal place
        ok = atom()
        while place < len(tokens) and tokens[place].upper() == "AND":
            place += 1
            ok = atom() and ok
        return ok

    def atom() -> bool:
        nonlocal place
        if place >= len(tokens):
            raise ValueError(expression)
        token = tokens[place]
        place += 1
        if token == "(":
            ok = disjunction()
            if place >= len(tokens) or tokens[place] != ")":
                raise ValueError(expression)
            place += 1
            return ok
        if token in {")"} or token.upper() in {"AND", "OR"}:
            raise ValueError(expression)
        ids.append(spdx(token.removesuffix("+")))
        return ids[-1] in ALLOWED

    try:
        ok = disjunction()
    except ValueError as exc:
        logger.debug("not an SPDX expression: %s", exc)
        return None
    if place != len(tokens):
        return None
    return ok, ids


def holds(expression: str) -> bool:
    result = evaluate(expression)
    return result is not None and result[0]


def known(license_id: str) -> bool:
    """Whether a License field's id is an SPDX id rather than prose. An id
    with an exception (`GPL-2.0-only WITH Classpath-exception-2.0`) is
    read by the id it modifies."""
    base = license_id.split(" WITH ")[0]
    return (
        license_id in ALLOWED
        or base in ALLOWED
        or base in CLASSIFIERS.values()
        or base.startswith("LicenseRef-")
        or re.fullmatch(r"[A-Za-z]+-[0-9.]+(-only|-or-later)?", base)
        is not None
    )


def classifier_license(name: str) -> str:
    """The license a trove classifier's last part names; one this script
    does not map stays in the expression as its own LicenseRef, so the
    check fails until it is mapped or excepted."""
    if name in CLASSIFIERS:
        return CLASSIFIERS[name]
    return "LicenseRef-Classifier-" + re.sub(
        r"[^A-Za-z0-9.]+", "-", name
    ).strip("-")


def pypi_license(info: dict[str, JsonValue]) -> str:
    """One SPDX expression for a PyPI release's core metadata.

    The License-Expression field first, then a one-line License field
    that names a license, then the trove classifiers.
    """
    expression = info.get("license_expression")
    if isinstance(expression, str) and expression.strip():
        return expression.strip()
    field = info.get("license")
    if isinstance(field, str) and field.strip() in PROSE:
        return PROSE[field.strip()]
    if isinstance(field, str) and "\n" not in field.strip():
        result = evaluate(field.strip())
        if result is not None and all(known(i) for i in result[1]):
            return field.strip()
    classifiers = info.get("classifiers")
    found: set[str] = set()
    if isinstance(classifiers, list):
        for classifier in classifiers:
            if isinstance(classifier, str) and classifier.startswith(
                "License ::"
            ):
                name = classifier.split(" :: ")[-1]
                # `License :: OSI Approved` alone is the category.
                if name != "OSI Approved":
                    found.add(classifier_license(name))
    if found:
        return " AND ".join(sorted(found))
    return "LicenseRef-Unknown"


Step: TypeAlias = tuple[str, str | None, list[str], str]


def step(dep: dict[str, Any], path: str) -> Step:
    """A dependency to walk: its name, the locked version it names when the
    lock holds several (one per Python version, say), its extras, and the
    path to it."""
    return (dep["name"], dep.get("version"), dep.get("extra", []), path)


def closure(lock: dict[str, Any]) -> dict[tuple[str, str], str]:
    """Every registry release the project's runtime, extras and dependency
    groups reach.

    Maps each name and locked version to one path to it from the project,
    led by the extra or group that brings it in, so a failure says why the
    package is there. A package locked at several versions is reached at
    each one a dependency names. A group never ships, but its tools run on
    every contributor's machine and in CI, so they answer to the same rule.
    """
    packages: dict[str, list[dict[str, Any]]] = {}
    for entry in lock["package"]:
        packages.setdefault(entry["name"], []).append(entry)
    (project,) = packages[PROJECT]
    stack: list[Step] = []
    for dep in project.get("dependencies", []):
        stack.append(step(dep, dep["name"]))
    # `all` repeats the other extras, so a path names the specific one.
    groups = project.get("optional-dependencies", {})
    for group in sorted(groups, key=lambda group: (group == "all", group)):
        for dep in groups[group]:
            stack.append(step(dep, f"[{group}] {dep['name']}"))
    for group, deps in sorted(project.get("dev-dependencies", {}).items()):
        for dep in deps:
            stack.append(step(dep, f"[{group} group] {dep['name']}"))
    stack.reverse()
    reached: dict[tuple[str, str], str] = {}
    walked: set[tuple[str, str, str]] = set()
    while stack:
        name, version, extras, path = stack.pop()
        for entry in packages.get(name, []):
            release = entry.get("version", "")
            if version is not None and release != version:
                continue
            if "registry" in entry.get("source", {}):
                reached.setdefault((name, release), path)
            for group in ["", *extras]:
                if (name, release, group) in walked:
                    continue
                walked.add((name, release, group))
                if group:
                    deps = entry.get("optional-dependencies", {}).get(
                        group, []
                    )
                else:
                    deps = entry.get("dependencies", [])
                for dep in deps:
                    stack.append(step(dep, f"{path} > {dep['name']}"))
    return reached


def fetch(name: str, version: str) -> dict[str, JsonValue]:
    url = f"https://pypi.org/pypi/{name}/{version}/json"
    request = urllib.request.Request(
        url, headers={"User-Agent": "mirage-license-check"}
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.load(response)
            info = data["info"]
            assert isinstance(info, dict)
            return info
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == 3:
                raise
            logger.debug("%s %s, try %d: %s", name, version, attempt + 1, exc)
            time.sleep(2**attempt)
    raise AssertionError("unreachable")


def python_packages() -> list[Package]:
    with LOCK.open("rb") as handle:
        lock = tomllib.load(handle)
    reached = closure(lock)
    with concurrent.futures.ThreadPoolExecutor(16) as pool:
        infos = dict(
            zip(reached, pool.map(lambda release: fetch(*release), reached))
        )
    return [
        Package(
            "python", name, version, pypi_license(infos[name, version]), path
        )
        for (name, version), path in sorted(reached.items())
    ]


def npm_packages(report: pathlib.Path) -> list[Package]:
    """`pnpm licenses list --json`, read from a file."""
    data = json.loads(report.read_text())
    out: list[Package] = []
    for license, entries in data.items():
        for entry in entries:
            for version in entry.get("versions", []):
                expression = (
                    "LicenseRef-Unknown" if license == "Unknown" else license
                )
                out.append(
                    Package("npm", entry["name"], version, expression, "")
                )
    return sorted(out, key=lambda p: (p.name, p.version))


@dataclass(frozen=True)
class Exemption:
    host: str
    pattern: str
    license: str
    # The releases it was reviewed for, a glob; None for any release.
    version: str | None

    def covers(self, package: Package) -> bool:
        return self.version is None or fnmatch.fnmatchcase(
            package.version, self.version
        )


def load_exceptions() -> list[Exemption]:
    """Each exception's host, name pattern, the license it was granted for
    and, when that license was read from the release's own files, the
    version it was read from."""
    with EXCEPTIONS.open("rb") as handle:
        data = tomllib.load(handle)
    out: list[Exemption] = []
    for host in ("python", "npm"):
        for entry in data.get(host, []):
            if not str(entry.get("reason", "")).strip():
                raise SystemExit(
                    f"{EXCEPTIONS.name}: {entry['name']} has no reason"
                )
            version = entry.get("version")
            if "LicenseRef-" in entry["license"] and version is None:
                raise SystemExit(
                    f"{EXCEPTIONS.name}: {entry['name']} rests on a reading "
                    "of its files and names no version"
                )
            out.append(
                Exemption(host, entry["name"], entry["license"], version)
            )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fail when a dependency is not permissively licensed."
    )
    parser.add_argument(
        "--python", action="store_true", help="check python/uv.lock"
    )
    parser.add_argument(
        "--npm",
        type=pathlib.Path,
        metavar="REPORT",
        help="check a `pnpm licenses list --json` report",
    )
    args = parser.parse_args()
    if not args.python and args.npm is None:
        parser.error("name --python, --npm REPORT, or both")
    packages: list[Package] = []
    if args.python:
        packages += python_packages()
    if args.npm is not None:
        packages += npm_packages(args.npm)
    exceptions = load_exceptions()
    used: set[tuple[str, str]] = set()
    failures: list[str] = []
    for package in packages:
        if holds(package.license):
            continue
        granted = [
            exception
            for exception in exceptions
            if exception.host == package.host
            and fnmatch.fnmatchcase(package.name, exception.pattern)
        ]
        match = next(
            (
                exception
                for exception in granted
                if exception.license == package.license
                and exception.covers(package)
            ),
            None,
        )
        if match is not None:
            used.add((package.host, match.pattern))
            continue
        line = (
            f"{package.host}: {package.name} {package.version} "
            f"is {package.license}"
        )
        if granted and granted[0].license != package.license:
            line += f" (the exception is for {granted[0].license})"
        elif granted:
            line += f" (the exception was reviewed for {granted[0].version})"
        if package.via:
            line += f", via {package.via}"
        failures.append(line)
    hosts = {package.host for package in packages}
    stale = sorted(
        f"{exception.host}: {exception.pattern}"
        for exception in exceptions
        if exception.host in hosts
        and (exception.host, exception.pattern) not in used
    )
    for line in failures:
        print(line)
    for line in stale:
        print(f"{line} is excepted but no longer needs it; remove its entry")
    print(
        f"{len(packages)} packages, {len(failures)} failing, "
        f"{len(stale)} stale exceptions"
    )
    return 1 if failures or stale else 0


if __name__ == "__main__":
    sys.exit(main())
