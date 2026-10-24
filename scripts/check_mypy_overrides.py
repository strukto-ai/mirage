import re
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OPTIONS = {
    "disallow_untyped_defs": "no-untyped-def",
    "warn_return_any": "no-any-return",
}
BLOCK = re.compile(
    r"^\[\[tool\.mypy\.overrides\]\]\n.*?(?=^\[|\Z)", re.M | re.S
)
ERROR = re.compile(r"^(.+?):\d+(?::\d+)?: error: .* \[([\w-]+)\]$")


def strict_config(source: str) -> tuple[str, dict[str, set[str]]]:
    """Lift annotation exemptions and remember which errors they suppress.

    Args:
        source (str): The project's TOML configuration.
    """
    exemptions: dict[str, set[str]] = {}

    def lift(match: re.Match[str]) -> str:
        block = match.group()
        override = tomllib.loads(block)["tool"]["mypy"]["overrides"][0]
        codes = {
            code
            for option, code in OPTIONS.items()
            if override.get(option) is False
        }
        if not codes:
            return block
        modules = override["module"]
        if isinstance(modules, str):
            modules = [modules]
        for module in modules:
            if "*" in module:
                raise ValueError(f"Use exact modules in the ratchet: {module}")
            exemptions.setdefault(module, set()).update(codes)
        for option in OPTIONS:
            block = re.sub(
                rf"(?m)^({option}\s*=\s*)false\b", r"\g<1>true", block
            )
        return block

    strict = BLOCK.sub(lift, source)
    overrides = (
        tomllib.loads(strict)
        .get("tool", {})
        .get("mypy", {})
        .get("overrides", [])
    )
    if any(
        override.get(option) is False
        for override in overrides
        for option in OPTIONS
    ):
        raise ValueError("Unrecognized mypy override formatting")
    return strict, exemptions


def audit(root: Path) -> list[str]:
    """Return stale modules, failing on missing files or unrelated errors.

    Both relaxed checks run in one mypy pass with normal import following.
    A separate incremental store keeps this audit out of the regular gate's
    cache. The original configuration is never changed.

    Args:
        root (Path): Repository root containing python/pyproject.toml.
    """
    python = root / "python"
    strict, exemptions = strict_config((python / "pyproject.toml").read_text())
    modules: dict[Path, str] = {}
    for name in exemptions:
        stem = python.joinpath(*name.split("."))
        path = stem.with_suffix(".py")
        if not path.is_file():
            path = stem / "__init__.py"
        if not path.is_file():
            raise ValueError(f"Exempt module no longer exists: {name}")
        modules[path.resolve()] = name
    if not exemptions:
        return []
    with tempfile.TemporaryDirectory(prefix="mirage-mypy-") as temporary:
        config = Path(temporary) / "pyproject.toml"
        config.write_text(strict)
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "mypy",
                "--config-file",
                str(config),
                "--cache-dir",
                str(python / ".mypy_cache/overrides"),
                "--no-pretty",
                "--no-color-output",
                "--no-error-summary",
                "--show-error-codes",
            ],
            cwd=python,
            text=True,
            capture_output=True,
        )
    if result.returncode not in (0, 1) or result.stderr.strip():
        raise ValueError(result.stdout + result.stderr)
    needed: set[str] = set()
    errors = 0
    for line in result.stdout.splitlines():
        if not line.strip() or ": note:" in line:
            continue
        match = ERROR.match(line)
        if match is None:
            raise ValueError(f"Unrecognized mypy output: {line}")
        errors += 1
        diagnostic_path, code = match.groups()
        module = modules.get((python / diagnostic_path).resolve())
        if module is None or code not in exemptions[module]:
            raise ValueError(f"Fix the regular mypy check first:\n{line}")
        needed.add(module)
    if (result.returncode == 1) != (errors > 0):
        raise ValueError("mypy status disagrees with its diagnostics")
    return sorted(set(exemptions) - needed)


def main() -> int:
    try:
        stale = audit(ROOT)
    except (OSError, ValueError) as error:
        print(f"mypy override audit failed: {error}", file=sys.stderr)
        return 1
    if stale:
        print("Remove stale mypy exemptions:\n  " + "\n  ".join(stale))
        return 1
    print("mypy overrides: every annotation exemption is still needed")
    return 0


def selftest() -> int:
    """Exercise both relaxed checks, package names, and fail-closed paths."""
    with tempfile.TemporaryDirectory(prefix="mirage-mypy-selftest-") as tmp:
        root = Path(tmp)
        package = root / "python/mirage"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text("")
        (package / "untyped.py").write_text("def f():\n    return 1\n")
        (package / "any_return.py").write_text(
            "from typing import Any\ndef f(value: Any) -> str:\n"
            "    return value\n"
        )
        config = root / "python/pyproject.toml"
        header = '[tool.mypy]\nfiles = ["mirage"]\n'
        overrides = (
            '[[tool.mypy.overrides]]\nmodule = ["mirage", '
            '"mirage.untyped", "mirage.any_return"]\n'
            "disallow_untyped_defs = false\nwarn_return_any = false\n"
        )
        config.write_text(header + overrides)
        assert audit(root) == ["mirage"]
        config.write_text(header + overrides.replace('"mirage", ', ""))
        assert audit(root) == []
        (package / "untyped.py").write_text("def f() -> int:\n    return 1\n")
        assert audit(root) == ["mirage.untyped"]
        for broken in [
            header + overrides.replace('"mirage"', '"mirage.missing"'),
            header + overrides.replace('"mirage"', '"mirage.*"'),
            header + 'python_version = "invalid"\n' + overrides,
            header
            + overrides.replace(
                "[[tool.mypy.overrides]]", "[[ tool.mypy.overrides ]]"
            ),
        ]:
            config.write_text(broken)
            try:
                audit(root)
            except ValueError:
                pass
            else:
                raise AssertionError("An invalid audit passed")
        config.write_text(header + overrides)
        (package / "any_return.py").write_text('value: int = "wrong"\n')
        try:
            audit(root)
        except ValueError as error:
            assert "regular mypy" in str(error), str(error)
        else:
            raise AssertionError("An unrelated mypy failure passed")
    print("mypy override selftest passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(selftest() if "--selftest" in sys.argv[1:] else main())
