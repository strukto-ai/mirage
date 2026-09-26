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

import re
from collections.abc import Sequence

from mirage.commands.builtin.rg_glob import Verdict, compile_glob
from mirage.commands.errors import UsageError

# ripgrep's refusal of a --type-add it cannot read, whatever is wrong
# with it (a missing glob, a bad name, `all`, an unknown include), exit 2
# (ripgrep 14.1.1).
INVALID_DEFINITION = ("rg: invalid definition (format is type:glob, "
                      "e.g., html:*.html)")
# The name that selects every type at once; it cannot be defined.
ALL_TYPES = "all"

# ripgrep 14.1.1's built-in file types, verbatim from `rg --type-list`:
# each name and the globs a file's name is matched against.
DEFAULT_TYPES: dict[str, tuple[str, ...]] = {
    "ada": ("*.adb", "*.ads"),
    "agda": ("*.agda", "*.lagda"),
    "aidl": ("*.aidl", ),
    "alire": ("alire.toml", ),
    "amake": ("*.bp", "*.mk"),
    "asciidoc": ("*.adoc", "*.asc", "*.asciidoc"),
    "asm": ("*.S", "*.asm", "*.s"),
    "asp": ("*.ascx", "*.ascx.cs", "*.ascx.vb", "*.asp", "*.aspx", "*.aspx.cs",
            "*.aspx.vb"),
    "ats": ("*.ats", "*.dats", "*.hats", "*.sats"),
    "avro": ("*.avdl", "*.avpr", "*.avsc"),
    "awk": ("*.awk", ),
    "bat": ("*.bat", ),
    "batch": ("*.bat", ),
    "bazel": ("*.BUILD", "*.bazel", "*.bazelrc", "*.bzl", "BUILD",
              "MODULE.bazel", "WORKSPACE", "WORKSPACE.bazel"),
    "bitbake": ("*.bb", "*.bbappend", "*.bbclass", "*.conf", "*.inc"),
    "brotli": ("*.br", ),
    "buildstream": ("*.bst", ),
    "bzip2": ("*.bz2", "*.tbz2"),
    "c": ("*.[chH]", "*.[chH].in", "*.cats"),
    "cabal": ("*.cabal", ),
    "candid": ("*.did", ),
    "carp": ("*.carp", ),
    "cbor": ("*.cbor", ),
    "ceylon": ("*.ceylon", ),
    "clojure": ("*.clj", "*.cljc", "*.cljs", "*.cljx"),
    "cmake": ("*.cmake", "CMakeLists.txt"),
    "cmd": ("*.bat", "*.cmd"),
    "cml": ("*.cml", ),
    "coffeescript": ("*.coffee", ),
    "config": ("*.cfg", "*.conf", "*.config", "*.ini"),
    "coq": ("*.v", ),
    "cpp": ("*.[ChH]", "*.[ChH].in", "*.[ch]pp", "*.[ch]pp.in", "*.[ch]xx",
            "*.[ch]xx.in", "*.cc", "*.cc.in", "*.hh", "*.hh.in", "*.inl"),
    "creole": ("*.creole", ),
    "crystal": ("*.cr", "*.ecr", "Projectfile", "shard.yml"),
    "cs": ("*.cs", ),
    "csharp": ("*.cs", ),
    "cshtml": ("*.cshtml", ),
    "csproj": ("*.csproj", ),
    "css": ("*.css", "*.scss"),
    "csv": ("*.csv", ),
    "cuda": ("*.cu", "*.cuh"),
    "cython": ("*.pxd", "*.pxi", "*.pyx"),
    "d": ("*.d", ),
    "dart": ("*.dart", ),
    "devicetree": ("*.dts", "*.dtsi"),
    "dhall": ("*.dhall", ),
    "diff": ("*.diff", "*.patch"),
    "dita": ("*.dita", "*.ditamap", "*.ditaval"),
    "docker": ("*Dockerfile*", ),
    "dockercompose": ("docker-compose.*.yml", "docker-compose.yml"),
    "dts": ("*.dts", "*.dtsi"),
    "dvc": ("*.dvc", "Dvcfile"),
    "ebuild": ("*.ebuild", "*.eclass"),
    "edn": ("*.edn", ),
    "elisp": ("*.el", ),
    "elixir": ("*.eex", "*.ex", "*.exs", "*.heex", "*.leex", "*.livemd"),
    "elm": ("*.elm", ),
    "erb": ("*.erb", ),
    "erlang": ("*.erl", "*.hrl"),
    "fennel": ("*.fnl", ),
    "fidl": ("*.fidl", ),
    "fish": ("*.fish", ),
    "flatbuffers": ("*.fbs", ),
    "fortran": ("*.F", "*.F77", "*.F90", "*.F95", "*.f", "*.f77", "*.f90",
                "*.f95", "*.pfo"),
    "fsharp": ("*.fs", "*.fsi", "*.fsx"),
    "fut": ("*.fut", ),
    "gap": ("*.g", "*.gap", "*.gd", "*.gi", "*.tst"),
    "gn": ("*.gn", "*.gni"),
    "go": ("*.go", ),
    "gprbuild": ("*.gpr", ),
    "gradle": ("*.gradle", "*.gradle.kts", "gradle-wrapper.*",
               "gradle.properties", "gradlew", "gradlew.bat"),
    "graphql": ("*.graphql", "*.graphqls"),
    "groovy": ("*.gradle", "*.groovy"),
    "gzip": ("*.gz", "*.tgz"),
    "h": ("*.h", "*.hh", "*.hpp"),
    "haml": ("*.haml", ),
    "hare": ("*.ha", ),
    "haskell": ("*.c2hs", "*.cpphs", "*.hs", "*.hsc", "*.lhs"),
    "hbs": ("*.hbs", ),
    "hs": ("*.hs", "*.lhs"),
    "html": ("*.ejs", "*.htm", "*.html"),
    "hy": ("*.hy", ),
    "idris": ("*.idr", "*.lidr"),
    "janet": ("*.janet", ),
    "java": ("*.java", "*.jsp", "*.jspx", "*.properties"),
    "jinja": ("*.j2", "*.jinja", "*.jinja2"),
    "jl": ("*.jl", ),
    "js": ("*.cjs", "*.js", "*.jsx", "*.mjs", "*.vue"),
    "json": ("*.json", "*.sarif", "composer.lock"),
    "jsonl": ("*.jsonl", ),
    "julia": ("*.jl", ),
    "jupyter": ("*.ipynb", "*.jpynb"),
    "k": ("*.k", ),
    "kotlin": ("*.kt", "*.kts"),
    "lean": ("*.lean", ),
    "less": ("*.less", ),
    "license":
    ("*[.-]LICEN[CS]E*", "AGPL-*[0-9]*", "APACHE-*[0-9]*", "BSD-*[0-9]*",
     "CC-BY-*", "COPYING", "COPYING[.-]*", "COPYRIGHT", "COPYRIGHT[.-]*",
     "EULA", "EULA[.-]*", "GFDL-*[0-9]*", "GNU-*[0-9]*", "GPL-*[0-9]*",
     "LGPL-*[0-9]*", "LICEN[CS]E", "LICEN[CS]E[.-]*", "MIT-*[0-9]*",
     "MPL-*[0-9]*", "NOTICE", "NOTICE[.-]*", "OFL-*[0-9]*", "PATENTS",
     "PATENTS[.-]*", "UNLICEN[CS]E", "UNLICEN[CS]E[.-]*", "agpl[.-]*",
     "gpl[.-]*", "lgpl[.-]*", "licen[cs]e", "licen[cs]e.*"),
    "lilypond": ("*.ily", "*.ly"),
    "lisp": ("*.el", "*.jl", "*.lisp", "*.lsp", "*.sc", "*.scm"),
    "lock": ("*.lock", "package-lock.json"),
    "log": ("*.log", ),
    "lua": ("*.lua", ),
    "lz4": ("*.lz4", ),
    "lzma": ("*.lzma", ),
    "m4": ("*.ac", "*.m4"),
    "make": ("*.mak", "*.mk", "[Gg][Nn][Uu]makefile",
             "[Gg][Nn][Uu]makefile.am", "[Gg][Nn][Uu]makefile.in",
             "[Mm]akefile", "[Mm]akefile.am", "[Mm]akefile.in"),
    "mako": ("*.mako", "*.mao"),
    "man": ("*.[0-9][cEFMmpSx]", "*.[0-9lnpx]"),
    "markdown":
    ("*.markdown", "*.md", "*.mdown", "*.mdwn", "*.mdx", "*.mkd", "*.mkdn"),
    "matlab": ("*.m", ),
    "md":
    ("*.markdown", "*.md", "*.mdown", "*.mdwn", "*.mdx", "*.mkd", "*.mkdn"),
    "meson": ("meson.build", "meson.options", "meson_options.txt"),
    "minified": ("*.min.css", "*.min.html", "*.min.js"),
    "mint": ("*.mint", ),
    "mk": ("mkfile", ),
    "ml": ("*.ml", ),
    "motoko": ("*.mo", ),
    "msbuild": ("*.csproj", "*.fsproj", "*.proj", "*.props", "*.sln",
                "*.targets", "*.vcxproj"),
    "nim": ("*.nim", "*.nimble", "*.nimf", "*.nims"),
    "nix": ("*.nix", ),
    "objc": ("*.h", "*.m"),
    "objcpp": ("*.h", "*.mm"),
    "ocaml": ("*.ml", "*.mli", "*.mll", "*.mly"),
    "org": ("*.org", "*.org_archive"),
    "pants": ("BUILD", ),
    "pascal": ("*.dpr", "*.inc", "*.lpr", "*.pas", "*.pp"),
    "pdf": ("*.pdf", ),
    "perl": ("*.PL", "*.perl", "*.pl", "*.plh", "*.plx", "*.pm", "*.t"),
    "php": ("*.php", "*.php3", "*.php4", "*.php5", "*.php7", "*.php8", "*.pht",
            "*.phtml"),
    "po": ("*.po", ),
    "pod": ("*.pod", ),
    "postscript": ("*.eps", "*.ps"),
    "prolog": ("*.P", "*.pl", "*.pro", "*.prolog"),
    "protobuf": ("*.proto", ),
    "ps": ("*.cdxml", "*.ps1", "*.ps1xml", "*.psd1", "*.psm1"),
    "puppet": ("*.epp", "*.erb", "*.pp", "*.rb"),
    "purs": ("*.purs", ),
    "py": ("*.py", "*.pyi"),
    "python": ("*.py", "*.pyi"),
    "qmake": ("*.prf", "*.pri", "*.pro"),
    "qml": ("*.qml", ),
    "r": ("*.R", "*.Rmd", "*.Rnw", "*.r"),
    "racket": ("*.rkt", ),
    "raku": ("*.p6", "*.pl6", "*.pm6", "*.raku", "*.rakudoc", "*.rakumod",
             "*.rakutest"),
    "rdoc": ("*.rdoc", ),
    "readme": ("*README", "README*"),
    "reasonml": ("*.re", "*.rei"),
    "red": ("*.r", "*.red", "*.reds"),
    "rescript": ("*.res", "*.resi"),
    "robot": ("*.robot", ),
    "rst": ("*.rst", ),
    "ruby": ("*.gemspec", "*.rb", "*.rbw", ".irbrc", "Gemfile", "Rakefile",
             "config.ru"),
    "rust": ("*.rs", ),
    "sass": ("*.sass", "*.scss"),
    "scala": ("*.sbt", "*.scala"),
    "sh":
    ("*.bash", "*.bashrc", "*.csh", "*.cshrc", "*.ksh", "*.kshrc", "*.sh",
     "*.tcsh", "*.zsh", ".bash_login", ".bash_logout", ".bash_profile",
     ".bashrc", ".cshrc", ".kshrc", ".login", ".logout", ".profile", ".tcshrc",
     ".zlogin", ".zlogout", ".zprofile", ".zshenv", ".zshrc", "bash_login",
     "bash_logout", "bash_profile", "bashrc", "profile", "zlogin", "zlogout",
     "zprofile", "zshenv", "zshrc"),
    "slim": ("*.skim", "*.slim", "*.slime"),
    "smarty": ("*.tpl", ),
    "sml": ("*.sig", "*.sml"),
    "solidity": ("*.sol", ),
    "soy": ("*.soy", ),
    "spark": ("*.spark", ),
    "spec": ("*.spec", ),
    "sql": ("*.psql", "*.sql"),
    "stylus": ("*.styl", ),
    "sv": ("*.h", "*.sv", "*.svh", "*.v", "*.vg"),
    "svelte": ("*.svelte", ),
    "svg": ("*.svg", ),
    "swift": ("*.swift", ),
    "swig": ("*.def", "*.i"),
    "systemd": ("*.automount", "*.conf", "*.device", "*.link", "*.mount",
                "*.path", "*.scope", "*.service", "*.slice", "*.socket",
                "*.swap", "*.target", "*.timer"),
    "taskpaper": ("*.taskpaper", ),
    "tcl": ("*.tcl", ),
    "tex": ("*.bib", "*.cls", "*.dtx", "*.ins", "*.ltx", "*.sty", "*.tex"),
    "texinfo": ("*.texi", ),
    "textile": ("*.textile", ),
    "tf": ("*.auto.tfvars", "*.auto.tfvars.json", "*.terraform.lock.hcl",
           "*.terraformrc", "*.tf", "*.tf.json", "*.tfrc", "terraform.rc",
           "terraform.tfvars", "terraform.tfvars.json"),
    "thrift": ("*.thrift", ),
    "toml": ("*.toml", "Cargo.lock"),
    "ts": ("*.cts", "*.mts", "*.ts", "*.tsx"),
    "twig": ("*.twig", ),
    "txt": ("*.txt", ),
    "typescript": ("*.cts", "*.mts", "*.ts", "*.tsx"),
    "typoscript": ("*.ts", "*.typoscript"),
    "usd": ("*.usd", "*.usda", "*.usdc"),
    "v": ("*.v", "*.vsh"),
    "vala": ("*.vala", ),
    "vb": ("*.vb", ),
    "vcl": ("*.vcl", ),
    "verilog": ("*.sv", "*.svh", "*.v", "*.vh"),
    "vhdl": ("*.vhd", "*.vhdl"),
    "vim": ("*.vim", ".gvimrc", ".vimrc", "_gvimrc", "_vimrc", "gvimrc",
            "vimrc"),
    "vimscript": ("*.vim", ".gvimrc", ".vimrc", "_gvimrc", "_vimrc", "gvimrc",
                  "vimrc"),
    "vue": ("*.vue", ),
    "webidl": ("*.idl", "*.webidl", "*.widl"),
    "wgsl": ("*.wgsl", ),
    "wiki": ("*.mediawiki", "*.wiki"),
    "xml": ("*.dtd", "*.rng", "*.sch", "*.xhtml", "*.xjb", "*.xml",
            "*.xml.dist", "*.xsd", "*.xsl", "*.xslt"),
    "xz": ("*.txz", "*.xz"),
    "yacc": ("*.y", ),
    "yaml": ("*.yaml", "*.yml"),
    "yang": ("*.yang", ),
    "z": ("*.Z", ),
    "zig": ("*.zig", ),
    "zsh": ("*.zsh", ".zlogin", ".zlogout", ".zprofile", ".zshenv", ".zshrc",
            "zlogin", "zlogout", "zprofile", "zshenv", "zshrc"),
    "zstd": ("*.zst", "*.zstd"),
}


def _add_glob(defs: dict[str, list[str]], name: str, glob: str) -> None:
    """Add one glob to a type, creating the type if it is new.

    Args:
        defs (dict[str, list[str]]): the type table being built.
        name (str): the type's name, alphanumeric and never ``all``.
        glob (str): the glob to add.
    """
    if name == ALL_TYPES or not name.isalnum():
        raise UsageError(INVALID_DEFINITION)
    defs.setdefault(name, []).append(glob)


def add_definition(defs: dict[str, list[str]], definition: str) -> None:
    """Apply one --type-add, ``name:glob`` or ``name:include:t1,t2``.

    Args:
        defs (dict[str, list[str]]): the type table being built.
        definition (str): the value as typed.

    Raises:
        UsageError: the definition is malformed, in ripgrep's words.
    """
    parts = definition.split(":")
    if len(parts) == 2:
        name, glob = parts
        if not name or not glob:
            raise UsageError(INVALID_DEFINITION)
        _add_glob(defs, name, glob)
        return
    if len(parts) == 3:
        name, keyword, included = parts
        if not name or keyword != "include" or not included:
            raise UsageError(INVALID_DEFINITION)
        names = included.split(",")
        if any(t not in defs for t in names):
            raise UsageError(INVALID_DEFINITION)
        for t in names:
            for glob in list(defs[t]):
                _add_glob(defs, name, glob)
        return
    raise UsageError(INVALID_DEFINITION)


class FileTypes:
    """ripgrep's -t/-T matcher (the ignore crate's ``Types``).

    Types match a file's name, never a directory. The last selection
    whose globs match decides: -t keeps the file whatever the hidden
    filter says, -T drops it. Once any -t is given, a file no selected
    type matches is dropped.

    Args:
        changes (Sequence[tuple[str, str]]): the --type-clear and
            --type-add values in line order, each as ``("clear", name)``
            or ``("add", definition)``.
        selections (Sequence[tuple[str, bool]]): the -t and -T names in
            line order, each with whether it negates (-T).

    Raises:
        UsageError: a definition is malformed, a selected type does not
            exist, or a selected glob does not compile.
    """

    def __init__(self, changes: Sequence[tuple[str, str]],
                 selections: Sequence[tuple[str, bool]]) -> None:
        defs = {name: list(globs) for name, globs in DEFAULT_TYPES.items()}
        for kind, value in changes:
            if kind == "clear":
                defs.pop(value, None)
            else:
                add_definition(defs, value)
        self.definitions = defs
        self._selected = any(not negated for _, negated in selections)
        globs: list[tuple[re.Pattern[str], bool]] = []
        for name, negated in selections:
            if name == ALL_TYPES:
                chosen = [g for gs in defs.values() for g in gs]
            elif name in defs:
                chosen = defs[name]
            else:
                raise UsageError(f"rg: unrecognized file type: {name}")
            globs.extend((compile_glob(g), negated) for g in chosen)
        self._globs = tuple(globs)

    def verdict(self, name: str, is_dir: bool) -> Verdict:
        """What the selections say about one walked entry.

        Args:
            name (str): the entry's file name.
            is_dir (bool): whether it is a directory.
        """
        if is_dir or not self._globs:
            return Verdict.NONE
        last: bool | None = None
        for matcher, negated in self._globs:
            if matcher.fullmatch(name):
                last = negated
        if last is None:
            return Verdict.IGNORE if self._selected else Verdict.NONE
        return Verdict.IGNORE if last else Verdict.WHITELIST


def type_listing(defs: dict[str, list[str]]) -> list[str]:
    """--type-list: every type and its globs, both sorted, one per line.

    Args:
        defs (dict[str, list[str]]): the type table after --type-add and
            --type-clear.
    """
    return [
        f"{name}: {', '.join(sorted(defs[name]))}" for name in sorted(defs)
    ]
