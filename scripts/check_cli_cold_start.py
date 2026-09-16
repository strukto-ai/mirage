from __future__ import annotations

import json
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TS = ROOT / "typescript"
SERVER = TS / "packages/server"
CLI = TS / "packages/cli"
SERVER_PKG = "@struktoai/mirage-server"

# The point of the subpath exports: a `mirage` spawn loads the HTTP client
# and nothing else. Each leaf entry costs 0.6-8.5ms to import; the server
# barrel that used to supply them costs ~800ms, which every spawn paid.
# One new import in one leaf module puts it all back.
HEAVY = (
    "@struktoai/mirage-node",
    "@struktoai/mirage-agents",
    "fastify",
    "@fastify/",
    "jose",
    "isomorphic-git",
    "rate-limiter-flexible",
)

# `.` is the barrel and is *meant* to be heavy; `./bin/daemon` is a program,
# not a module anyone imports for a symbol.
UNGATED_SUBPATHS = (".", "./package.json", "./bin/daemon")

# One pattern for every static form, because the first version of this gate
# used `[^;\n]*?` and so matched only single-line imports -- blind to the
# multi-line block form this repo's formatter produces at three or more
# named imports, which is exactly the shape the gate exists to refuse.
# `[^'"]*?` cannot cross a string literal, so the clause cannot run past
# the end of its own statement. Covers: `import x from 's'`, the block
# form over any number of lines, `export ... from 's'`, and the
# side-effect `import 's'`. A dynamic `import('s')` is not matched, since
# `import` is followed by `(` rather than a clause or a quote -- and that
# is the whole point: deferring an import is what the gate rewards.
STATIC_IMPORT_RE = re.compile(
    r"""(?:^|\n)[ \t]*(?P<kind>import|export)\b[ \t]*(?P<type>type\b)?"""
    r"""(?:[^'"]*?\bfrom[ \t\n]*)?['"](?P<spec>[^'"]+)['"]""",
    re.S,
)


class UnresolvedImport(Exception):
    """A relative import the walker could not resolve to a file.

    Raised rather than skipped: a silent skip collapses the graph to the
    entry alone and the gate then reports "reaches no heavy package" over
    a subtree it never looked at.
    """


def static_imports(text: str) -> list[tuple[str, bool]]:
    """Every statically imported specifier in one module's source.

    Args:
        text (str): The module's source.

    Returns:
        list[tuple[str, bool]]: (specifier, is_type_only) in source order.
    """
    return [(m.group("spec"), m.group("type") is not None)
            for m in STATIC_IMPORT_RE.finditer(text)]


def bare_specifiers(entry: Path) -> tuple[set[str], list[str]]:
    """Every bare specifier an entry reaches through static imports.

    Relative imports are followed, because tsup splits shared code into
    `chunk-*.js` and a leaf entry's real graph spans several files.

    Args:
        entry (Path): A built javascript file.

    Returns:
        tuple[set[str], list[str]]: the bare specifiers reached, and the
        names of the files walked.

    Raises:
        UnresolvedImport: A relative specifier resolved to no file.
    """
    seen: set[Path] = set()
    bare: set[str] = set()
    queue = [entry]
    while queue:
        current = queue.pop()
        if current in seen:
            continue
        seen.add(current)
        for spec, _type_only in static_imports(current.read_text()):
            if not spec.startswith("."):
                bare.add(spec)
                continue
            target = (current.parent / spec).resolve()
            if not target.is_file():
                raise UnresolvedImport(
                    f"{current.name} imports {spec}, which resolves to no "
                    f"file ({target}); the walk below it would be silent")
            queue.append(target)
    return bare, sorted(p.name for p in seen)


def gated_entries() -> dict[str, Path]:
    """Every built entry the gate walks.

    The server's light subpaths, plus the CLI binary itself -- the CLI is
    what pays the cold start, and its own three deferrals
    (`mirage-agents/mcp`, `mirage-node/config`, `yaml`) are ungated
    without it.

    Returns:
        dict[str, Path]: a display name -> built javascript file.
    """
    manifest = json.loads((SERVER / "package.json").read_text())
    out: dict[str, Path] = {}
    for subpath, target in manifest.get("exports", {}).items():
        if subpath in UNGATED_SUBPATHS:
            continue
        rel = target["import"] if isinstance(target, dict) else target
        out[f"{SERVER_PKG}{subpath[1:]}"] = SERVER / rel
    out["mirage (cli binary)"] = CLI / "dist/bin/mirage.js"
    return out


def check_entries() -> list[str]:
    """Fail an entry whose static graph reaches a heavy package.

    Returns:
        list[str]: one line per offending (entry, specifier).
    """
    problems: list[str] = []
    for name, path in sorted(gated_entries().items()):
        if not path.is_file():
            problems.append(f"{name}: {path} is missing; run "
                            f"`pnpm -r build` before this gate")
            continue
        try:
            bare, walked = bare_specifiers(path)
        except UnresolvedImport as err:
            problems.append(f"{name}: {err}")
            continue
        for spec in sorted(bare):
            if spec.startswith(HEAVY):
                problems.append(f"{name} reaches {spec} "
                                f"(walked {', '.join(walked)})")
    return problems


def check_cli_sources() -> list[str]:
    """Fail a CLI source that imports the server barrel by its bare name.

    No file exemptions, deliberately: the two that most want one
    (`mcp.ts`, `workspace.ts`) are the two whose regression costs the
    most, so whitelisting them would blind the gate to its own subject.
    A type-only import is allowed, because `verbatimModuleSyntax` erases
    it and it reaches no module at runtime.

    Returns:
        list[str]: one line per offending file.
    """
    problems: list[str] = []
    for path in sorted((CLI / "src").rglob("*.ts")):
        for spec, type_only in static_imports(path.read_text()):
            if spec == SERVER_PKG and not type_only:
                problems.append(
                    f"{path.relative_to(TS)} imports {SERVER_PKG} bare; "
                    f"use the subpath that supplies the symbol")
                break
    return problems


def check_splitting() -> list[str]:
    """Fail if tsup's code splitting has been turned off.

    Splitting is what lets one module shared by two entries stay one
    module. Without it esbuild copies it into each entry, so the seven
    leaf subpaths stop sharing `paths`/`daemon_config` with the barrel and
    each grows its own duplicate -- and any class reached from two entries
    (`DaemonConfigError`) exists twice, so `instanceof` across them
    silently stops matching.

    Returns:
        list[str]: one line per place splitting is disabled.
    """
    problems: list[str] = []
    if re.search(r"splitting:\s*false",
                 (SERVER / "tsup.config.ts").read_text()):
        problems.append("packages/server/tsup.config.ts sets "
                        "`splitting: false`")
    manifest = json.loads((SERVER / "package.json").read_text())
    if "--no-splitting" in manifest.get("scripts", {}).get("build", ""):
        problems.append("packages/server build script passes "
                        "`--no-splitting`")
    return [
        f"{p}; that duplicates a shared module into every entry and "
        f"breaks `instanceof` across two of them" for p in problems
    ]


# Each case is a module source and whether the gate should call it heavy.
# The block form is first because its absence is what made the first
# version of this gate blind to a straight revert of the change it guards.
SELFTEST_IMPORTS = (
    ("import {\n  A,\n  B,\n} from '@struktoai/mirage-node'", True),
    ("import { a } from '@struktoai/mirage-node'", True),
    ("import '@struktoai/mirage-node'", True),
    ("export { a } from 'fastify'", True),
    ("import { a } from '@fastify/multipart'", True),
    ("const { a } = await import('@struktoai/mirage-node')", False),
    ("const { a } = await import(\n  '@struktoai/mirage-node'\n)", False),
    ("import { a } from 'node:fs'", False),
    ("import { a } from '@struktoai/mirage-core/utils/sort'", False),
    ("program.option('--from <branch>', 'Branch to fork from', 'jose')",
     False),
)

# The other half of the gate: which spellings count as importing the
# barrel from a CLI source.
SELFTEST_BARREL = (
    ("import { A } from '@struktoai/mirage-server'", True),
    ("import {\n  A,\n  B,\n} from '@struktoai/mirage-server'", True),
    ("import '@struktoai/mirage-server'", True),
    ("import type { A } from '@struktoai/mirage-server'", False),
    ("import { A } from '@struktoai/mirage-server/paths'", False),
    ("const { A } = await import('@struktoai/mirage-server')", False),
)


def selftest(tmp: Path) -> int:
    """Prove the gate's own patterns see what it claims they see.

    Args:
        tmp (Path): A writable directory for fixture modules.

    Returns:
        int: 0 when every case classifies correctly.
    """
    failures = 0
    fixture = tmp / "fixture.js"
    for source, want in SELFTEST_IMPORTS:
        fixture.write_text(source + "\n")
        bare, _ = bare_specifiers(fixture)
        got = any(spec.startswith(HEAVY) for spec in bare)
        if got != want:
            failures += 1
            print(f"  walker: {source!r} -> heavy={got}, want {want}")
    for source, want in SELFTEST_BARREL:
        got = any(spec == SERVER_PKG and not type_only
                  for spec, type_only in static_imports(source))
        if got != want:
            failures += 1
            print(f"  barrel: {source!r} -> bare={got}, want {want}")
    fixture.write_text("import { a } from './missing.js'\n")
    try:
        bare_specifiers(fixture)
    except UnresolvedImport:
        pass
    else:
        failures += 1
        print("  walker: an unresolvable relative import was skipped in "
              "silence instead of raising")
    total = len(SELFTEST_IMPORTS) + len(SELFTEST_BARREL) + 1
    if failures:
        print(f"\n{failures} of {total} selftest case(s) failed; the gate "
              f"is blind to a shape it claims to catch")
        return 1
    print(f"selftest OK: {total} import shapes covered")
    return 0


def main() -> int:
    if "--selftest" in sys.argv[1:]:
        with tempfile.TemporaryDirectory() as tmp:
            return selftest(Path(tmp))
    problems = check_entries() + check_cli_sources() + check_splitting()
    if problems:
        print(f"{len(problems)} cold-start regression(s):")
        for line in problems:
            print(f"  {line}")
        print("\nThe mirage CLI pays every one of these on every spawn. "
              "See 'CLIs' in CLAUDE.md.")
        return 1
    print(f"cli cold start: {len(gated_entries())} entries reach no heavy "
          f"package; no cli source imports the server barrel bare")
    return 0


if __name__ == "__main__":
    sys.exit(main())
