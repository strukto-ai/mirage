import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RUST = ROOT / "rust"
WHEEL = ROOT / "python/THIRD_PARTY_NOTICES"
CORE = ROOT / "typescript/packages/core/THIRD_PARTY_NOTICES"
RULE = "-" * 72
# Source adapted into rust/ from permissively licensed projects, which
# cargo about cannot see because it is not a dependency.
ADAPTED = [
    ROOT / "licenses/third_party/jq.txt",
    ROOT / "licenses/third_party/nfsserve.txt",
    ROOT / "licenses/third_party/pcre2.txt",
    ROOT / "licenses/third_party/uutils-coreutils.txt",
    ROOT / "licenses/third_party/regex-automata.txt",
    ROOT / "licenses/third_party/ripgrep.txt",
    ROOT / "licenses/third_party/unicode-data.txt",
    ROOT / "licenses/third_party/xxd.txt",
]
CORE_LEAD = (
    "The WebAssembly module embedded in this package (src/generated/"
    "mirage_rs.ts,\nbuilt from rust/ in https://github.com/strukto-ai/mirage) "
    "is compiled from the\nRust crates below, each listed under the license "
    "it came with:"
)
WHEEL_LEAD = (
    "The native module in this package (mirage._rs, built from rust/ in\n"
    "https://github.com/strukto-ai/mirage) is compiled from the Rust crates "
    "below,\nPyO3 included, each listed under the license it came with:"
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


def append(path: pathlib.Path, lead: str, manifest: str) -> None:
    """Rewrite a package's notices after its hand-kept sections: `lead`,
    then the crates its binding compiles in.

    Args:
        path (pathlib.Path): the package's THIRD_PARTY_NOTICES.
        lead (str): the paragraph the generated sections follow.
        manifest (str): the binding's Cargo.toml, relative to rust/.
    """
    text = path.read_text()
    at = text.find(lead)
    if at >= 0:
        text = text[: text.rfind(RULE, 0, at)].rstrip("\n") + "\n"
    path.write_text(f"{text}\n{RULE}\n\n{lead}\n\n{notices(manifest)}")


def main() -> int:
    append(WHEEL, WHEEL_LEAD, "python/Cargo.toml")
    append(CORE, CORE_LEAD, "wasm/Cargo.toml")
    print(f"wrote {WHEEL.relative_to(ROOT)}, {CORE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
