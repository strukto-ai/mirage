import argparse
import hashlib
import json
import os
import platform
import subprocess
import time
from pathlib import Path

HARNESS_FILES = (
    "benchmark-browser.ts",
    "benchmark-chrome.ts",
    "benchmark-node.ts",
    "benchmark-pairs.py",
    "benchmark-suite.ts",
    "benchmark.py",
)


def harness_manifest(root: Path) -> dict[str, str]:
    return {
        name: hashlib.sha256(
            (root / "integ/policy" / name).read_bytes()
        ).hexdigest()
        for name in HARNESS_FILES
    }


def capture(command: list[str], cwd: Path) -> str:
    return subprocess.check_output(command, cwd=cwd, text=True).strip()


def dirty_manifest(root: Path) -> dict[str, str | None]:
    changed = subprocess.check_output(
        ["git", "diff", "--name-only", "-z", "HEAD"], cwd=root
    )
    untracked = subprocess.check_output(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=root
    )
    paths = sorted(set((changed + untracked).decode().split("\0")) - {""})
    included = {"rust", "python", "typescript", "integ", "scripts"}
    manifest: dict[str, str | None] = {}
    for name in paths:
        path = root / name
        if Path(name).parts[0] not in included or ".audit" in Path(name).parts:
            continue
        manifest[name] = (
            hashlib.sha256(path.read_bytes()).hexdigest()
            if path.is_file()
            else None
        )
    return manifest


def metadata(root: Path) -> dict:
    native = Path(
        capture(
            [
                str(root / "python/.venv/bin/python"),
                "-c",
                "import mirage._rs; print(mirage._rs.__file__)",
            ],
            root / "python",
        )
    )
    artifacts = [
        native,
        root
        / "rust/target/wasm32-unknown-unknown/release/mirage_rs_wasm.wasm",
        root / "typescript/packages/core/dist/generated/mirage_rs.js",
        *root.glob("typescript/packages/core/dist/policy/**/*.js"),
        *root.glob("typescript/packages/core/dist/rs/*.js"),
    ]
    manifest = dirty_manifest(root)
    return {
        "root": str(root),
        "revision": capture(["git", "rev-parse", "HEAD"], root),
        "diff_sha256": hashlib.sha256(
            subprocess.check_output(["git", "diff", "HEAD"], cwd=root)
        ).hexdigest(),
        "dirty_manifest": manifest,
        "dirty_manifest_sha256": hashlib.sha256(
            json.dumps(
                manifest, sort_keys=True, separators=(",", ":")
            ).encode()
        ).hexdigest(),
        "harness": harness_manifest(root),
        "native_import_path": str(native),
        "artifacts": {
            str(
                path.relative_to(root) if path.is_relative_to(root) else path
            ): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in artifacts
        },
        "toolchain": {
            "rustc": capture(["rustc", "--version"], root / "rust"),
            "cargo": capture(["cargo", "--version"], root / "rust"),
            "python": capture(
                [str(root / "python/.venv/bin/python"), "--version"], root
            ),
            "node": capture(["node", "--version"], root),
            "pnpm": capture(["pnpm", "--version"], root / "typescript"),
            "rust_toolchain_file": (
                root / "rust/rust-toolchain.toml"
            ).read_text(),
        },
        "required_build_commands": [
            "cd python && uv sync --all-extras",
            "cd typescript && pnpm install --frozen-lockfile",
            "cd typescript && pnpm --filter @struktoai/mirage-core "
            "--filter @struktoai/mirage-node --filter @struktoai/mirage-browser build",
        ],
        "build_note": (
            "Native and Wasm must be built in release mode. Commands are "
            "reproduction instructions, not proof they ran; retain build logs. "
            "Artifact hashes include loaded native extension and distributed Wasm."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Alternate benchmarks between two release checkouts."
    )
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--pairs", type=int, default=5)
    parser.add_argument(
        "--host", choices=("python", "node", "chrome"), required=True
    )
    args = parser.parse_args()
    if args.pairs < 5:
        parser.error("at least five pairs are required")
    roots = [args.baseline.resolve(), args.candidate.resolve()]
    try:
        manifests = [harness_manifest(root) for root in roots]
    except OSError as error:
        parser.error(f"cannot read all six harness files: {error}")
    if manifests[0] != manifests[1]:
        parser.error("baseline and candidate harness manifests differ")
    print(
        json.dumps(
            {
                "metadata": [metadata(root) for root in roots],
                "system": platform.platform(),
                "cores": os.cpu_count(),
                "load": os.getloadavg(),
                "method": (
                    "At least five A/B process pairs. Each workload checks correctness "
                    "before checked warm repetitions. Process wall includes setup; "
                    "Chrome wall includes bundling. Startup/import fields exclude "
                    "workloads. Default workspace limits are unchanged."
                ),
            }
        ),
        flush=True,
    )
    for pair in range(args.pairs):
        for side, root in zip(("baseline", "candidate"), roots):
            command = (
                [
                    str(root / "python/.venv/bin/python"),
                    str(root / "integ/policy/benchmark.py"),
                ]
                if args.host == "python"
                else [
                    "node",
                    "--import",
                    "tsx",
                    f"policy/benchmark-{args.host}.ts",
                ]
            )
            started = time.perf_counter()
            result = capture(
                command,
                root / ("python" if args.host == "python" else "integ"),
            )
            print(
                json.dumps(
                    {
                        "pair": pair,
                        "side": side,
                        "process_ms": (time.perf_counter() - started) * 1000,
                        "result": json.loads(result),
                    }
                ),
                flush=True,
            )


if __name__ == "__main__":
    main()
