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
import io
import json
import pathlib
import sys
import tarfile
import tempfile
import zipfile
from typing import TypeAlias

ROOT = pathlib.Path(__file__).resolve().parent.parent
LICENSE = (ROOT / "LICENSE").read_bytes()
NOTICES = "THIRD_PARTY_NOTICES"


def package_dirs() -> list[pathlib.Path]:
    """Every directory a package is published from. npm and the Python
    builds ship only what the package's own directory holds, so each one
    keeps a copy of the root LICENSE."""
    dirs = [ROOT / "python", ROOT / "rust/python"]
    for manifest in sorted(
        (ROOT / "typescript/packages").glob("*/package.json")
    ):
        if not json.loads(manifest.read_text()).get("private", False):
            dirs.append(manifest.parent)
    return dirs


def check_copies() -> list[str]:
    out: list[str] = []
    for directory in package_dirs():
        copy = directory / "LICENSE"
        name = copy.relative_to(ROOT)
        if not copy.is_file():
            out.append(f"{name} is missing")
        elif copy.read_bytes() != LICENSE:
            out.append(f"{name} differs from LICENSE")
    return out


def wheel_files(path: pathlib.Path) -> dict[str, bytes]:
    """A wheel's license files, by name."""
    with zipfile.ZipFile(path) as wheel:
        return {
            member.rsplit("/", 1)[-1]: wheel.read(member)
            for member in wheel.namelist()
            if ".dist-info/licenses/" in member
        }


def tar_files(path: pathlib.Path, top: str | None) -> dict[str, bytes]:
    """The files at the top of a tarball's one root directory, by name;
    `top` names that directory when it is known (`package` for npm)."""
    out: dict[str, bytes] = {}
    with tarfile.open(path) as archive:
        for member in archive.getmembers():
            parts = member.name.split("/")
            if len(parts) != 2 or not member.isfile():
                continue
            if top is not None and parts[0] != top:
                continue
            handle = archive.extractfile(member)
            if handle is not None:
                out[parts[1]] = handle.read()
    return out


def wants_notices(files: dict[str, bytes]) -> bool:
    """Whether an npm package lists the notices among its `files`, so a
    tarball without them lost a file the package means to ship."""
    manifest = json.loads(files.get("package.json", b"{}"))
    return NOTICES in manifest.get("files", [])


def check_artifact(path: pathlib.Path) -> list[str]:
    """Each wheel and sdist carries LICENSE and the notices; each npm
    tarball carries LICENSE, and the notices when it lists them."""
    if path.name.endswith(".whl"):
        files, notices = wheel_files(path), True
    elif path.name.endswith(".tgz"):
        files = tar_files(path, "package")
        notices = wants_notices(files)
    elif path.name.endswith(".tar.gz"):
        files, notices = tar_files(path, None), True
    else:
        return [f"{path.name}: not a wheel, sdist or npm tarball"]
    out: list[str] = []
    if "LICENSE" not in files:
        out.append(f"{path.name} has no LICENSE")
    elif files["LICENSE"] != LICENSE:
        out.append(f"{path.name}'s LICENSE differs from LICENSE")
    if notices and NOTICES not in files:
        out.append(f"{path.name} has no {NOTICES}")
    return out


Members: TypeAlias = dict[str, bytes]

OTHER = b"another license\n"
LISTED = json.dumps({"files": ["dist", NOTICES]}).encode()
UNLISTED = json.dumps({"files": ["dist"]}).encode()

# Each fixture artifact, its members, and what the check must report
# about it (the text after the artifact's name).
SELFTEST: tuple[tuple[str, Members, tuple[str, ...]], ...] = (
    ("a.whl", {"LICENSE": LICENSE, NOTICES: b"n"}, ()),
    ("b.whl", {"LICENSE": LICENSE}, (f" has no {NOTICES}",)),
    (
        "c.whl",
        {"LICENSE": OTHER, NOTICES: b"n"},
        ("'s LICENSE differs from LICENSE",),
    ),
    ("d-1.0.tar.gz", {"LICENSE": LICENSE, NOTICES: b"n"}, ()),
    ("e-1.0.tar.gz", {NOTICES: b"n"}, (" has no LICENSE",)),
    ("f.tgz", {"package.json": LISTED, "LICENSE": LICENSE, NOTICES: b"n"}, ()),
    (
        "g.tgz",
        {"package.json": LISTED, "LICENSE": LICENSE},
        (f" has no {NOTICES}",),
    ),
    ("h.tgz", {"package.json": UNLISTED, "LICENSE": LICENSE}, ()),
    ("i.tgz", {"package.json": UNLISTED}, (" has no LICENSE",)),
    ("j.zip", {"LICENSE": LICENSE}, (": not a wheel, sdist or npm tarball",)),
)


def build(path: pathlib.Path, members: Members) -> None:
    """A fixture artifact laid out as its kind is: a wheel's license files
    under its dist-info, an sdist's and an npm tarball's under their one
    root directory."""
    if path.name.endswith((".whl", ".zip")):
        with zipfile.ZipFile(path, "w") as wheel:
            for name, data in members.items():
                wheel.writestr(f"pkg-1.0.dist-info/licenses/{name}", data)
        return
    top = (
        "package"
        if path.name.endswith(".tgz")
        else path.name[: -len(".tar.gz")]
    )
    with tarfile.open(path, "w:gz") as archive:
        for name, data in members.items():
            info = tarfile.TarInfo(f"{top}/{name}")
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))


def selftest(tmp: pathlib.Path) -> int:
    """Prove the archive checks report what they claim on fixtures of each
    kind: the PR workflow otherwise only checks the package directories.

    Args:
        tmp (pathlib.Path): A writable directory for the fixtures.
    """
    failures = 0
    for name, members, want in SELFTEST:
        path = tmp / name
        build(path, members)
        got = tuple(line.removeprefix(name) for line in check_artifact(path))
        if got != want:
            failures += 1
            print(f"  {name}: {list(got)}, want {list(want)}")
    if failures:
        print(f"{failures} of {len(SELFTEST)} selftest cases failed")
        return 1
    print(f"selftest OK: {len(SELFTEST)} artifacts")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fail when a package would ship without its license."
    )
    parser.add_argument(
        "artifacts",
        nargs="*",
        type=pathlib.Path,
        help="built wheels, sdists or npm tarballs; with none, check "
        "that every published package directory holds LICENSE",
    )
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="run the archive checks on fixtures of every kind",
    )
    args = parser.parse_args()
    if args.selftest:
        with tempfile.TemporaryDirectory() as tmp:
            return selftest(pathlib.Path(tmp))
    if args.artifacts:
        failures = [
            line for path in args.artifacts for line in check_artifact(path)
        ]
        checked = f"{len(args.artifacts)} artifacts"
    else:
        failures = check_copies()
        checked = f"{len(package_dirs())} package directories"
    for line in failures:
        print(line)
    print(f"{checked}, {len(failures)} failing")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
