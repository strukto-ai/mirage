"""Compare VFS.md texts after language escapes and formatting whitespace.

Each VFS keeps its part of VFS.md in a ``VFS_MD`` constant of its class
module (gcal adds its bucket fragments). Python's AST and TypeScript's own
parser read the literals; neither imports a backend. Every text must have a
peer. Runtime differences need named reasons, and an exception that no
longer describes a difference fails the gate.
"""

from __future__ import annotations

import argparse
import ast
import json
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
LOAD_TS = """
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const ts = createRequire(process.argv[1])('typescript');
const result = {};
for (const path of process.argv.slice(2)) {
  const source = ts.createSourceFile(
    path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const found = {};
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const d of statement.declarationList.declarations) {
      const name = d.name.getText(source);
      if (!name.endsWith('VFS_MD')) continue;
      const value = d.initializer;
      found[name] = value !== undefined && ts.isStringLiteralLike(value)
        ? value.text : null;
    }
  }
  result[path] = found;
}
process.stdout.write(JSON.stringify(result));
"""


def normalize(value: str) -> str:
    return " ".join(value.split())


def python_texts(path: Path) -> dict[str, str]:
    texts: dict[str, str] = {}
    for statement in ast.parse(path.read_text()).body:
        if not isinstance(statement, ast.Assign):
            continue
        for target in statement.targets:
            if isinstance(target, ast.Name) and target.id.endswith("VFS_MD"):
                value = ast.literal_eval(statement.value)
                if not isinstance(value, str):
                    raise ValueError(f"{path}: {target.id} is not a string")
                texts[target.id] = normalize(value)
    return texts


def typescript_texts(paths: list[Path]) -> dict[str, dict[str, str]]:
    run = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            LOAD_TS,
            str(REPO / "typescript/package.json"),
            *map(str, paths),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    loaded = json.loads(run.stdout)
    texts: dict[str, dict[str, str]] = {}
    for path in paths:
        found: dict[str, str] = {}
        for name, value in loaded[str(path)].items():
            if not isinstance(value, str):
                raise ValueError(f"{path}: {name} is not a string literal")
            found[name] = normalize(value)
        if found:
            texts[str(path)] = found
    return texts


def candidates(paths: list[Path]) -> list[Path]:
    return [p for p in paths if "VFS_MD" in p.read_text()]


def differences(repo: Path) -> dict[str, str]:
    py: dict[str, dict[str, str]] = {}
    for path in candidates(
        sorted((repo / "python/mirage/vfs").glob("*/*.py"))
    ):
        found = python_texts(path)
        if found:
            py[path.parent.name] = found
    paths = candidates(
        [
            p
            for p in sorted(
                (repo / "typescript/packages").glob("*/src/vfs/*/*.ts")
            )
            if not p.name.endswith(".test.ts")
        ]
    )
    if not py or not paths:
        raise ValueError("no VFS.md texts discovered")
    ts = typescript_texts(paths)
    gaps: dict[str, str] = {}
    seen: set[str] = set()
    for spelled, b in ts.items():
        module = Path(spelled)
        backend = module.parent.name
        runtime = module.relative_to(repo / "typescript/packages").parts[0]
        seen.add(backend)
        a = py.get(backend, {})
        for name in sorted(a.keys() | b.keys()):
            key = f"{runtime}/{backend}/{name}"
            if name not in a:
                gaps[key] = "missing Python text"
            elif name not in b:
                gaps[key] = "missing TypeScript text"
            elif a[name] != b[name]:
                gaps[key] = "text differs"
    for backend in sorted(py.keys() - seen):
        for name in py[backend]:
            gaps[f"python/{backend}/{name}"] = "missing TypeScript backend"
    return gaps


def violations(gaps: dict[str, str], exceptions: dict[str, str]) -> list[str]:
    errors = [
        f"{key}: {reason}"
        for key, reason in sorted(gaps.items())
        if key not in exceptions
    ]
    for key, reason in sorted(exceptions.items()):
        if not isinstance(reason, str) or not reason.strip():
            errors.append(f"{key}: exception needs a reason")
        if key not in gaps:
            errors.append(f"{key}: stale exception")
    return errors


def selftest() -> None:
    assert normalize(' {prefix}  {"x": 1} ') == '{prefix} {"x": 1}'
    assert normalize("a\\nb") != normalize("a\nb")
    assert normalize("a\n  b") == normalize("a b")
    assert violations({"core/a/DAY_VFS_MD": "missing"}, {})
    assert not violations(
        {"browser/a/VFS_MD": "diff"}, {"browser/a/VFS_MD": "runtime"}
    )
    assert violations({}, {"browser/a/VFS_MD": "runtime"})
    assert violations({"browser/a/VFS_MD": "diff"}, {"browser/a/VFS_MD": ""})
    with TemporaryDirectory() as directory:
        repo = Path(directory)
        py = repo / "python/mirage/vfs/demo/demo.py"
        ts = repo / "typescript/packages/core/src/vfs/demo/demo.ts"
        py.parent.mkdir(parents=True)
        ts.parent.mkdir(parents=True)
        # Literal backslash-n, a backtick, braces and Unicode must survive
        # language decoding without losing their meaning.
        value = '{prefix} {"x": "é\\n`"}'
        py.write_text(
            "import os\n\nVFS_MD = " + repr(value) + "\n\n\nclass Demo:\n"
            "    vfs_md = VFS_MD\n"
        )
        ts.write_text(
            "import { BaseVFS } from '../base.ts'\n\n"
            "export const VFS_MD: string = " + json.dumps(value) + "\n"
        )
        assert differences(repo) == {}
        ts.write_text(ts.read_text() + "export const DAY_VFS_MD = `day`\n")
        assert differences(repo) == {
            "core/demo/DAY_VFS_MD": "missing Python text"
        }
        ts.write_text("export const VFS_MD = `wrong`\n")
        assert differences(repo) == {"core/demo/VFS_MD": "text differs"}
        ts.write_text("export const VFS_MD = `a${1}b`\n")
        try:
            differences(repo)
        except ValueError:
            pass
        else:
            raise AssertionError("a substituted template must be refused")
        ts.unlink()
        other = ts.parent.parent / "other/other.ts"
        other.parent.mkdir()
        other.write_text('export const VFS_MD = "x"\n')
        assert differences(repo) == {
            "core/other/VFS_MD": "missing Python text",
            "python/demo/VFS_MD": "missing TypeScript backend",
        }
    print("VFS.md parity self-tests passed")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
    gaps = differences(REPO)
    exceptions = json.loads(
        (REPO / "scripts/parity/vfs_md_exceptions.json").read_text()
    )
    errors = violations(gaps, exceptions)
    if errors:
        print("\n".join(errors))
        return 1
    print(f"VFS.md parity passed ({len(exceptions)} runtime differences)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
