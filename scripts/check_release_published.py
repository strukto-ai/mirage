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
import io
import json
import pathlib
import re
import sys
import tarfile
import urllib.error
import urllib.request
from typing import Any

from check_release_versions import NPM_PACKAGES, npm_tag, pep440

ROOT = pathlib.Path(__file__).resolve().parent.parent
PYPI = "https://pypi.org/pypi"
NPM = "https://registry.npmjs.org"
ABBREVIATED = "application/vnd.npm.install-v1+json"
NPM_SCOPE = "@struktoai/"
DEPENDENCY_FIELDS = (
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
)
ENTRY_FIELDS = ("main", "module", "types", "bin", "exports", "imports")
RELEASE = r"\d+\.\d+\.\d+"

NPM_FILES = {
    "@struktoai/mirage-fuse": tuple(
        f"bin/mirage-fuse-{target}"
        for target in (
            "x86_64",
            "aarch64",
            "armv7l",
            "armv6l",
            "darwin-x86_64",
            "darwin-arm64",
        )
    ),
}

PYPI_FILES = {
    "mirage-ai": {
        "sdist": r"\.tar\.gz$",
        "macOS arm64": r"macosx_\d+_\d+_arm64\.whl$",
        "macOS x86_64": r"macosx_\d+_\d+_x86_64\.whl$",
        "Linux glibc arm64": r"manylinux_\d+_\d+_aarch64\.whl$",
        "Linux glibc x86_64": r"manylinux_\d+_\d+_x86_64\.whl$",
        "Linux musl arm64": r"musllinux_\d+_\d+_aarch64\.whl$",
        "Linux musl x86_64": r"musllinux_\d+_\d+_x86_64\.whl$",
        "Windows x86_64": r"win_amd64\.whl$",
        "Windows arm64": r"win_arm64\.whl$",
    },
    "mirage-fuse": {
        "macOS arm64": r"macosx_\d+_\d+_arm64\.whl$",
        "macOS x86_64": r"macosx_\d+_\d+_x86_64\.whl$",
        "Linux arm64": r"linux_\d+_\d+_aarch64\.whl$",
        "Linux x86_64": r"linux_\d+_\d+_x86_64\.whl$",
        "Linux armv7": r"armv7l\.whl$",
        "Linux armv6": r"armv6l\.whl$",
    },
}


def fetch(url: str, accept: str) -> dict[str, Any] | None:
    """A registry document, or None when the registry has no such name.

    Args:
        url (str): the document's URL.
        accept (str): the media type to ask for.
    """
    request = urllib.request.Request(
        url,
        headers={"Accept": accept, "User-Agent": "mirage-release-check"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            document: dict[str, Any] = json.load(response)
            return document
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def check_pypi(project: str, version: str) -> tuple[list[str], str]:
    """What is wrong with one PyPI project's release, and what a plain
    `pip install` of the project picks.

    Args:
        project (str): the PyPI project name.
        version (str): the PyPI spelling of the release.
    """
    latest = fetch(f"{PYPI}/{project}/json", "application/json")
    default = latest["info"]["version"] if latest else ""
    release = fetch(f"{PYPI}/{project}/{version}/json", "application/json")
    if release is None:
        return [f"{version} is not on PyPI"], default
    files = release["urls"]
    names = [file["filename"] for file in files]
    problems = [
        f"no {label} file"
        for label, pattern in PYPI_FILES[project].items()
        if not any(re.search(pattern, name) for name in names)
    ]
    problems += [f"{f['filename']} is yanked" for f in files if f["yanked"]]
    return problems, default


def check_npm(name: str, version: str, tag: str) -> tuple[list[str], str]:
    """What is wrong with one npm package's release, and what its `latest`
    dist-tag (a plain `npm install`) serves.

    Args:
        name (str): the npm package name.
        version (str): the npm spelling of the release.
        tag (str): the dist-tag the release goes out under.
    """
    packument = fetch(f"{NPM}/{name}", ABBREVIATED)
    if packument is None:
        return [f"{name} is not on npm"], ""
    tags = packument["dist-tags"]
    latest = tags.get("latest", "")
    manifest = packument["versions"].get(version)
    if manifest is None:
        return [f"{version} is not on npm"], latest
    problems = []
    if tags.get(tag) != version:
        problems.append(f"dist-tag {tag} is {tags.get(tag)}, not {version}")
    if tag != "latest" and "-" in latest and latest != version:
        releases = [
            v for v in packument["versions"] if re.fullmatch(RELEASE, v)
        ]
        if releases:
            newest = max(releases, key=lambda v: tuple(map(int, v.split("."))))
            problems.append(
                f"dist-tag latest is the pre-release {latest} though "
                f"{newest} is out: npm dist-tag add {name}@{newest} latest"
            )
        else:
            problems.append(
                f"dist-tag latest is the older pre-release {latest}, and the "
                f"package has no release for it to fall back to: "
                f"npm dist-tag add {name}@{version} latest"
            )
    for field in DEPENDENCY_FIELDS:
        for dependency, spec in manifest.get(field, {}).items():
            if dependency.startswith(NPM_SCOPE) and spec != version:
                problems.append(f"{field} {dependency} is {spec}")
    problems += check_tarball(name, manifest["dist"]["tarball"])
    return problems, latest


def entry_paths(field: str, value: Any) -> list[str]:
    """The files a package.json entry field names, `./` stripped. Under
    `exports` and `imports` only `./` targets are files; a bare name there
    is another package. An `imports` entry's `types` serves the package's
    own build from source, so the tarball needs only its runtime targets.

    Args:
        field (str): the package.json field the value sits under.
        value (Any): the field's value, or one of its nested values.
    """
    if isinstance(value, dict):
        return [
            p
            for key, v in value.items()
            if not (field == "imports" and key == "types")
            for p in entry_paths(field, v)
        ]
    if isinstance(value, list):
        return [p for v in value for p in entry_paths(field, v)]
    if not isinstance(value, str):
        return []
    if field in ("exports", "imports") and not value.startswith("./"):
        return []
    return [value.removeprefix("./")]


def check_tarball(name: str, url: str) -> list[str]:
    """The files a published npm tarball should hold and does not: LICENSE,
    every file its package.json's entry points name, and the package's
    own executables.

    Args:
        name (str): the npm package name.
        url (str): the tarball's registry URL.
    """
    request = urllib.request.Request(
        url, headers={"User-Agent": "mirage-release-check"}
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        data = response.read()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        files = {
            m.name.removeprefix("package/")
            for m in archive.getmembers()
            if m.isfile() and m.name.startswith("package/")
        }
        if "package.json" not in files:
            return ["tarball has no package/package.json"]
        extracted = archive.extractfile("package/package.json")
        package = json.load(extracted) if extracted else {}
    wanted = {"LICENSE": "LICENSE", "package.json": "package.json"}
    for field in ENTRY_FIELDS:
        for path in entry_paths(field, package.get(field)):
            wanted.setdefault(path, field)
    for path in NPM_FILES.get(name, ()):
        wanted.setdefault(path, "executable")
    problems = []
    for path, field in wanted.items():
        pattern = re.escape(path).replace(r"\*", ".+")
        if not any(re.fullmatch(pattern, file) for file in files):
            problems.append(f"tarball has no {path} ({field})")
    return problems


def npm_names() -> list[str]:
    manifests = [
        *(f"typescript/packages/{name}/package.json" for name in NPM_PACKAGES),
        "rust/fuse/package.json",
    ]
    return [
        json.loads((ROOT / path).read_text())["name"] for path in manifests
    ]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Check that a release is on PyPI and npm, complete, "
        "under the right dist-tags, with its own packages pinned to it."
    )
    parser.add_argument(
        "version",
        nargs="?",
        help="the npm spelling (0.1.0-alpha.4); defaults to this checkout's",
    )
    args = parser.parse_args()
    version = (args.version or "").removeprefix("v") or json.loads(
        (ROOT / "rust/fuse/package.json").read_text()
    )["version"]
    python_version = pep440(version)
    tag = npm_tag(python_version)
    with concurrent.futures.ThreadPoolExecutor(16) as pool:
        pypi = {
            project: pool.submit(check_pypi, project, python_version)
            for project in PYPI_FILES
        }
        npm = {
            name: pool.submit(check_npm, name, version, tag)
            for name in npm_names()
        }
        rows = [
            (f"PyPI {project} {python_version}", *future.result())
            for project, future in pypi.items()
        ] + [
            (f"npm {name}@{version}", *future.result())
            for name, future in npm.items()
        ]
    failed = 0
    for label, problems, default in rows:
        status = "FAIL" if problems else "ok"
        print(f"{status:<4} {label}  (plain install: {default or 'none'})")
        for problem in problems:
            print(f"       {problem}")
        failed += bool(problems)
    if failed:
        sys.exit(
            f"{failed} of {len(rows)} packages are not right; a registry "
            "can take minutes to show a fresh publish, so re-run before "
            "publishing again"
        )
    print(f"all {len(rows)} packages are published at {version} ({tag})")


if __name__ == "__main__":
    main()
