import json
import os
import pathlib
import re
import sys
import tomllib

ROOT = pathlib.Path(__file__).resolve().parent.parent

# The npm packages a release builds and publishes; opencode is not
# published yet.
NPM_PACKAGES = ("agents", "browser", "cli", "core", "dsh", "node", "server")

# Cargo and npm spell a pre-release `0.0.7-alpha.2`, PyPI `0.0.7a2`.
PRE_RELEASES = {"alpha": "a", "beta": "b", "rc": "rc"}


def pep440(version: str) -> str:
    """The PyPI spelling of a Cargo or npm version.

    Args:
        version (str): `0.0.7` or `0.0.7-alpha.2`.
    """
    match = re.fullmatch(
        r"(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.(\d+))?", version
    )
    if match is None:
        sys.exit(f"not a release version: {version!r}")
    base, pre, number = match.groups()
    return base if pre is None else f"{base}{PRE_RELEASES[pre]}{number}"


def npm_tag(version: str) -> str:
    """The dist-tag a version goes out under: its pre-release word, else latest.

    Args:
        version (str): the PyPI spelling.
    """
    match = re.fullmatch(r"\d+\.\d+\.\d+(a|b|rc)\d+", version)
    if match is None:
        return "latest"
    return {short: word for word, short in PRE_RELEASES.items()}[match[1]]


def main(tag: str) -> None:
    project = tomllib.loads((ROOT / "python/pyproject.toml").read_text())[
        "project"
    ]
    pins = [
        dep.removeprefix("mirage-rs==")
        for dep in project["dependencies"]
        if dep.startswith("mirage-rs")
    ]
    if len(pins) != 1 or "==" in pins[0] or pins[0].startswith("mirage-rs"):
        sys.exit(f"mirage-ai must pin mirage-rs with ==, found {pins!r}")
    cargo = tomllib.loads((ROOT / "rust/Cargo.toml").read_text())
    found = {
        "python/pyproject.toml": project["version"],
        "python/pyproject.toml mirage-rs pin": pins[0],
        "rust/Cargo.toml": pep440(cargo["workspace"]["package"]["version"]),
    }
    for name in NPM_PACKAGES:
        path = f"typescript/packages/{name}/package.json"
        found[path] = pep440(json.loads((ROOT / path).read_text())["version"])
    if tag:
        bare = tag.removeprefix("v")
        found[f"tag {tag}"] = pep440(bare) if "-" in bare else bare
    if len(set(found.values())) != 1:
        for where, version in found.items():
            print(f"{version:<12} {where}")
        sys.exit("the release versions disagree")
    version = found["python/pyproject.toml"]
    print(f"every package is at {version}; npm dist-tag {npm_tag(version)}")
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a") as file:
            file.write(
                f"version={version}\nnpm-tag={npm_tag(version)}\n"
                f"npm-packages={' '.join(NPM_PACKAGES)}\n"
            )


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "")
