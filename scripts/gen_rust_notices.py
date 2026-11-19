import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RUST = ROOT / "rust"
WHEEL = ROOT / "python/THIRD_PARTY_NOTICES"
CORE = ROOT / "typescript/packages/core/THIRD_PARTY_NOTICES"
FUSE = ROOT / "rust/fuse/THIRD_PARTY_NOTICES"
RULE = "-" * 72
# Source adapted into rust/ from permissively licensed projects, which
# cargo about cannot see because it is not a dependency.
ADAPTED = [
    ROOT / "licenses/third_party/cobra.txt",
    ROOT / "licenses/third_party/gh.txt",
    ROOT / "licenses/third_party/go-gh.txt",
    ROOT / "licenses/third_party/go.txt",
    ROOT / "licenses/third_party/gojq.txt",
    ROOT / "licenses/third_party/jq.txt",
    ROOT / "licenses/third_party/nfsserve.txt",
    ROOT / "licenses/third_party/officecli.txt",
    ROOT / "licenses/third_party/oniguruma.txt",
    ROOT / "licenses/third_party/pcre2.txt",
    ROOT / "licenses/third_party/pflag.txt",
    ROOT / "licenses/third_party/uutils-coreutils.txt",
    ROOT / "licenses/third_party/regex-automata.txt",
    ROOT / "licenses/third_party/ripgrep.txt",
    ROOT / "licenses/third_party/unicode-data.txt",
    ROOT / "licenses/third_party/xxd.txt",
    ROOT / "licenses/third_party/tree-sitter-bash-parser.txt",
]
CORE_LEAD = (
    "The WebAssembly modules shipped in this package (dist/generated/"
    "mirage_rs.wasm,\nmirage_shell.wasm, mirage_gh.wasm, mirage_pdf.wasm and "
    "mirage_ast_grep.wasm, "
    "built from rust/ in\nhttps://github.com/strukto-ai/mirage) are compiled "
    "from the Rust crates below,\neach listed under the license it came with:"
)
WHEEL_LEAD = (
    "The native module in this package (mirage._rs, built from rust/ in\n"
    "https://github.com/strukto-ai/mirage) is compiled from the Rust crates "
    "below,\nPyO3 included, each listed under the license it came with:"
)
FUSE_LEAD = (
    "The mirage-fuse executables in these packages (built from rust/fuse in\n"
    "https://github.com/strukto-ai/mirage) are compiled from the Rust crates "
    "below,\neach listed under the license it came with:"
)


def crate_sections(manifest: str) -> list[str]:
    """The notices for the crates one binding compiles in.

    Args:
        manifest (str): the binding's Cargo.toml, relative to rust/.
    """
    out = subprocess.run(
        [
            "cargo",
            "about",
            "generate",
            "--config",
            str(RUST / "about.toml"),
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
    return [
        part.strip()
        for part in out.stdout.split("%%section%%")
        if part.strip()
    ]


def bundled(ast_grep: list[str]) -> list[str]:
    """The sections every binding with the shell carries after its crates:
    the syntax parser and the source adapted into rust/.

    Args:
        ast_grep (list[str]): notices for the shared syntax parser.
    """
    sections = [
        "Mirage is licensed under Apache-2.0. The bundled WebAssembly module "
        "uses\nast-grep under the MIT license, reproduced below. Its Rust "
        "dependencies\nare listed under their respective licenses.",
        (ROOT / "licenses/third_party/ast-grep.txt").read_text().strip(),
    ]
    sections.extend(ast_grep)
    sections.extend(path.read_text().strip() for path in ADAPTED)
    return sections


def notices(manifest: str, extra: list[str]) -> str:
    sections = crate_sections(manifest) + extra
    joined = f"\n\n{RULE}\n\n".join(sections)
    return "\n".join(line.rstrip() for line in joined.splitlines()) + "\n"


def append(
    path: pathlib.Path, lead: str, manifest: str, extra: list[str]
) -> None:
    """Rewrite a package's notices after its hand-kept sections: `lead`,
    then the crates its binding compiles in. The generated part starts at
    the rule before the lead's opening words, which name the binding and
    stay when the modules listed after them change.

    Args:
        path (pathlib.Path): the package's THIRD_PARTY_NOTICES.
        lead (str): the paragraph the generated sections follow.
        manifest (str): the binding's Cargo.toml, relative to rust/.
        extra (list[str]): the sections after the binding's crates.
    """
    text = path.read_text()
    at = text.find(lead.split(" (", 1)[0])
    if at >= 0:
        text = text[: text.rfind(RULE, 0, at)].rstrip("\n") + "\n"
    path.write_text(f"{text}\n{RULE}\n\n{lead}\n\n{notices(manifest, extra)}")


def main() -> int:
    shared = bundled(crate_sections("ast-grep/Cargo.toml"))
    append(WHEEL, WHEEL_LEAD, "python/Cargo.toml", shared)
    append(CORE, CORE_LEAD, "pdf-wasm/Cargo.toml", shared)
    append(FUSE, FUSE_LEAD, "fuse/Cargo.toml", [])
    written = ", ".join(str(p.relative_to(ROOT)) for p in (WHEEL, CORE, FUSE))
    print(f"wrote {written}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
