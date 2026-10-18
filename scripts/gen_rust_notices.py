import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RUST = ROOT / "rust"
WHEEL = RUST / "python/THIRD_PARTY_NOTICES"
CORE = ROOT / "typescript/packages/core/THIRD_PARTY_NOTICES"
RULE = "-" * 72
# Source adapted into rust/ from permissively licensed projects, which
# cargo about cannot see because it is not a dependency.
ADAPTED = [
    ROOT / "licenses/third_party/uutils-coreutils.txt",
    ROOT / "licenses/third_party/unicode-data.txt",
]
CORE_LEAD = (
    "The WebAssembly module embedded in this package (src/generated/"
    "mirage_rs.ts,\nbuilt from rust/ in https://github.com/strukto-ai/mirage) "
    "is compiled from the\nRust crates below, each listed under the license "
    "it came with:"
)
WHEEL_HEAD = (
    "Third-party notices for mirage-rs, the Python package.\n\n"
    "The package's native module is compiled from the Rust crates below, "
    "PyO3\nincluded, each listed under the license it came with."
)


def notices(manifest: str) -> str:
    """The notices for the crates one binding compiles in.

    Args:
        manifest (str): the binding's Cargo.toml, relative to rust/.
    """
    out = subprocess.run(
        [
            "cargo",
            "about",
            "generate",
            "--manifest-path",
            str(RUST / manifest),
            str(RUST / "about.hbs"),
        ],
        cwd=RUST,
        stdout=subprocess.PIPE,
        text=True,
        check=True,
    )
    # about.hbs ends each license with this line, as a text need not end
    # in a newline.
    sections = [
        part.strip()
        for part in out.stdout.split("%%section%%")
        if part.strip()
    ]
    sections += [path.read_text().strip() for path in ADAPTED]
    joined = f"\n\n{RULE}\n\n".join(sections)
    return "\n".join(line.rstrip() for line in joined.splitlines()) + "\n"


def main() -> int:
    wheel = notices("python/Cargo.toml")
    WHEEL.write_text(f"{WHEEL_HEAD}\n\n{RULE}\n\n{wheel}")
    core = CORE.read_text()
    at = core.find(CORE_LEAD)
    if at >= 0:
        core = core[: core.rfind(RULE, 0, at)].rstrip("\n") + "\n"
    wasm = notices("wasm/Cargo.toml")
    CORE.write_text(f"{core}\n{RULE}\n\n{CORE_LEAD}\n\n{wasm}")
    print(f"wrote {WHEEL.relative_to(ROOT)}, {CORE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
