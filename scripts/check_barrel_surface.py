from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TS = REPO / "typescript"
CORE_INDEX = TS / "packages/core/src/index.ts"
CORE_PKG = "@struktoai/mirage-core"
RUNTIME_PKGS = ("node", "browser")
CONSUMER_ROOTS = ("examples", "docs", "integ", "plugins", "typescript/scripts")
SOURCE_SUFFIXES = {".ts", ".tsx", ".mts", ".mjs", ".js", ".md", ".mdx"}

CLAUSE = r"\s+(type\s+)?\{([^{}]*)\}\s*from\s*['\"]([^'\"]+)['\"]"
BLOCK_RE = re.compile(r"^(?:import|export)" + CLAUSE, re.M | re.S)
DYNAMIC_RE = re.compile(r"import\(\s*['\"]([^'\"]+)['\"]\s*\)")
NAMESPACE_RE = re.compile(
    r"^(?:import|export)\s+\*\s+as\s+(\w+)\s+from\s*['\"]([^'\"]+)['\"]", re.M
)
STAR_RE = re.compile(r"^export\s+\*\s+from\s*['\"]([^'\"]+)['\"]", re.M)


def specifier_names(body: str, keep: str) -> list[str]:
    """Read the names out of one `{...}` clause.

    Args:
        body: The text between the braces.
        keep: "local" for the name the module declares, "public" for the
            name the clause publishes (they differ under `as`).

    Returns:
        The requested names, in source order.
    """
    body = re.sub(r"//[^\n]*", "", body)
    names: list[str] = []
    for raw in body.split(","):
        token = raw.strip()
        if not token:
            continue
        if token.startswith("type "):
            token = token[5:].strip()
        parts = [p.strip() for p in token.split(" as ")]
        names.append(parts[0] if keep == "local" else parts[-1])
    return names


def source_files(root: Path) -> list[Path]:
    """Every file under a root that could carry an import.

    Args:
        root: Directory to walk.

    Returns:
        Matching files, skipping node_modules and build output.
    """
    if not root.is_dir():
        return []
    return [
        p
        for p in root.rglob("*")
        if p.is_file()
        and p.suffix in SOURCE_SUFFIXES
        and "node_modules" not in p.parts
        and "dist" not in p.parts
    ]


def barrel_names(index: Path) -> set[str]:
    """The names core's index.ts publishes.

    Args:
        index: Path to `packages/core/src/index.ts`.

    Returns:
        Every publicly exported name.
    """
    src = index.read_text()
    names = {
        n
        for m in BLOCK_RE.finditer(src)
        for n in specifier_names(m.group(2), "public")
    }
    names |= {m.group(1) for m in NAMESPACE_RE.finditer(src)}
    return names


def own_exports(pkg: str) -> set[str]:
    """The names a runtime package publishes from its own modules.

    Args:
        pkg: "node" or "browser".

    Returns:
        Names that reach a consumer without passing through core's barrel.
    """
    src = (TS / f"packages/{pkg}/src/index.ts").read_text()
    names: set[str] = set()
    # Any module but the bare barrel supplies the name itself, core subpaths
    # included: only the `export * from core` line draws on index.ts, so a
    # name spelled out beside it is this package's own regardless of origin.
    for m in BLOCK_RE.finditer(src):
        if m.group(3) != CORE_PKG:
            names |= set(specifier_names(m.group(2), "public"))
    for m in NAMESPACE_RE.finditer(src):
        if m.group(2) != CORE_PKG:
            names.add(m.group(1))
    return names


def barrel_imports_in_packages() -> list[str]:
    """Package sources that still reach for core's barrel.

    Returns:
        One `path:name` line per offending import, empty when clean.
    """
    offenders: list[str] = []
    for pkg_dir in sorted((TS / "packages").iterdir()):
        if not (pkg_dir / "src").is_dir():
            continue
        for path in source_files(pkg_dir / "src"):
            src = path.read_text()
            rel = path.relative_to(REPO)
            for m in BLOCK_RE.finditer(src):
                if m.group(3) == CORE_PKG:
                    offenders.append(f"{rel}: {{ {m.group(2).strip()} }}")
            for m in NAMESPACE_RE.finditer(src):
                if m.group(2) == CORE_PKG:
                    offenders.append(f"{rel}: * as {m.group(1)}")
            for m in DYNAMIC_RE.finditer(src):
                if m.group(1) == CORE_PKG:
                    offenders.append(f"{rel}: await import(...)")
            if pkg_dir.name not in RUNTIME_PKGS:
                continue
            for m in STAR_RE.finditer(src):
                if m.group(1) == CORE_PKG and path.name != "index.ts":
                    offenders.append(f"{rel}: export *")
    return offenders


def names_consumers_import() -> set[str]:
    """Barrel names the repo's own consumers ask for.

    Returns:
        Names imported from core directly, plus names taken from a runtime
        package that only its `export * from core` line can supply.
    """
    used: set[str] = set()
    runtime_own = {pkg: own_exports(pkg) for pkg in RUNTIME_PKGS}
    for root in CONSUMER_ROOTS:
        for path in source_files(REPO / root):
            src = path.read_text(errors="ignore")
            for m in BLOCK_RE.finditer(src):
                module = m.group(3)
                if module == CORE_PKG:
                    used |= set(specifier_names(m.group(2), "local"))
                    continue
                for pkg in RUNTIME_PKGS:
                    if module == f"@struktoai/mirage-{pkg}":
                        used |= (
                            set(specifier_names(m.group(2), "local"))
                            - runtime_own[pkg]
                        )
            for m in NAMESPACE_RE.finditer(src):
                if m.group(2) == CORE_PKG:
                    used |= barrel_names(CORE_INDEX)
    return used


def main() -> int:
    """Fail when core's barrel grows a line no consumer asked for.

    Returns:
        0 when both rules hold, 1 otherwise.
    """
    failures: list[str] = []

    offenders = barrel_imports_in_packages()
    if offenders:
        failures.append(
            f"{len(offenders)} package source(s) import core through its "
            f"barrel. Name the module instead -- the `./*` subpath map makes "
            f"every core module importable, and a barrel import is what grew "
            f"index.ts to 1500 lines:\n  " + "\n  ".join(offenders[:20])
        )

    declared = barrel_names(CORE_INDEX)
    used = names_consumers_import()
    unused = sorted(declared - used)
    if unused:
        failures.append(
            f"{len(unused)} name(s) in packages/core/src/index.ts have no "
            f"consumer under {', '.join(CONSUMER_ROOTS)}. knip cannot see "
            f"this: its project root is typescript/, which leaves the "
            f"barrel's real consumers outside its graph.\n  "
            + "\n  ".join(unused)
        )

    # The other direction, which tsc only half covers: it reads examples and
    # integ, but a name in a docs page is prose to it. A consumer asking for
    # a name the barrel does not carry is the failure a shrunken index.ts
    # invites, so the gate owns both halves rather than one.
    missing = sorted(used - declared)
    if missing:
        failures.append(
            f"{len(missing)} name(s) imported from {CORE_PKG} by a consumer "
            f"under {', '.join(CONSUMER_ROOTS)} are not exported by "
            f"packages/core/src/index.ts. Add the line, or point the consumer "
            f"at the module that declares it.\n  " + "\n  ".join(missing)
        )

    if failures:
        print("\n\n".join(failures), file=sys.stderr)
        return 1
    print(
        f"core barrel: {len(declared)} names, every one imported by a "
        f"consumer; no package source imports the barrel"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
