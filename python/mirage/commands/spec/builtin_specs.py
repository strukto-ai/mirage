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

from mirage.commands.spec.types import (CommandSpec, Operand, OperandKind,
                                        Option)

SPECS: dict[str, CommandSpec] = {
    "ls":
    CommandSpec(
        options=(
            Option(short="-l"),
            Option(short="-a"),
            Option(short="-A"),
            Option(short="-h"),
            Option(short="-t"),
            Option(short="-S"),
            Option(short="-r"),
            Option(short="-1"),
            Option(short="-R"),
            Option(short="-d"),
            Option(short="-F"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "stat":
    CommandSpec(
        options=(
            Option(short="-c", value_kind=OperandKind.TEXT),
            Option(short="-f", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "pwd":
    CommandSpec(
        options=(
            Option(short="-P"),
            Option(short="-L"),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "find":
    CommandSpec(
        options=(
            Option(short="-name", value_kind=OperandKind.TEXT),
            Option(short="-type", value_kind=OperandKind.TEXT),
            Option(short="-maxdepth", value_kind=OperandKind.TEXT),
            Option(short="-size", value_kind=OperandKind.TEXT),
            Option(short="-mtime", value_kind=OperandKind.TEXT),
            Option(short="-iname", value_kind=OperandKind.TEXT),
            Option(short="-path", value_kind=OperandKind.TEXT),
            Option(short="-mindepth", value_kind=OperandKind.TEXT),
            Option(short="-print"),
            Option(short="-print0"),
            Option(short="-delete"),
            Option(short="-prune"),
            Option(short="-ls"),
            Option(short="-empty"),
            Option(short="-o"),
            Option(short="-or"),
            Option(short="-a"),
            Option(short="-and"),
            Option(short="-not"),
        ),
        rest=Operand(kind=OperandKind.PATH),
        ignore_tokens=frozenset({"(", ")"}),
    ),
    "tree":
    CommandSpec(
        options=(
            Option(short="-a"),
            Option(short="-L", value_kind=OperandKind.TEXT),
            Option(short="-I", value_kind=OperandKind.TEXT),
            Option(short="-d"),
            Option(short="-P", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "du":
    CommandSpec(
        options=(
            Option(short="-h"),
            Option(short="-s"),
            Option(short="-a"),
            Option(long="--max-depth", value_kind=OperandKind.TEXT),
            Option(short="-c"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "cat":
    CommandSpec(
        options=(Option(short="-n"), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "head":
    CommandSpec(
        options=(
            Option(short="-n",
                   value_kind=OperandKind.TEXT,
                   numeric_shorthand=True),
            Option(short="-c", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "tail":
    CommandSpec(
        options=(
            Option(short="-n",
                   value_kind=OperandKind.TEXT,
                   numeric_shorthand=True),
            Option(short="-c", value_kind=OperandKind.TEXT),
            Option(short="-q"),
            Option(short="-v"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "wc":
    CommandSpec(
        options=(
            Option(short="-l"),
            Option(short="-w"),
            Option(short="-c"),
            Option(short="-m"),
            Option(short="-L"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "md5":
    CommandSpec(rest=Operand(kind=OperandKind.PATH)),
    "diff":
    CommandSpec(
        options=(
            Option(short="-i"),
            Option(short="-w"),
            Option(short="-b"),
            Option(short="-e"),
            Option(short="-u"),
            Option(short="-q"),
            Option(short="-r"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "file":
    CommandSpec(
        options=(
            Option(short="-b"),
            Option(short="-i"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "python":
    CommandSpec(
        options=(Option(short="-c", value_kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "python3":
    CommandSpec(
        options=(Option(short="-c", value_kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "nl":
    CommandSpec(
        options=(
            Option(short="-b", value_kind=OperandKind.TEXT),
            Option(short="-v", value_kind=OperandKind.TEXT),
            Option(short="-i", value_kind=OperandKind.TEXT),
            Option(short="-w", value_kind=OperandKind.TEXT),
            Option(short="-s", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "grep":
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-R"),
            Option(short="-i"),
            Option(short="-I"),
            Option(short="-v"),
            Option(short="-n"),
            Option(short="-c"),
            Option(short="-l"),
            Option(short="-w"),
            Option(short="-F"),
            Option(short="-E"),
            Option(short="-o"),
            Option(short="-q"),
            Option(short="-H"),
            Option(short="-h"),
            Option(short="-m", value_kind=OperandKind.TEXT),
            Option(short="-A", value_kind=OperandKind.TEXT),
            Option(short="-B", value_kind=OperandKind.TEXT),
            Option(short="-C", value_kind=OperandKind.TEXT),
            Option(short="-e", value_kind=OperandKind.TEXT),
        ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "rg":
    CommandSpec(
        options=(
            Option(short="-i"),
            Option(short="-v"),
            Option(short="-n"),
            Option(short="-c"),
            Option(short="-l"),
            Option(short="-w"),
            Option(short="-F"),
            Option(short="-o"),
            Option(short="-m", value_kind=OperandKind.TEXT),
            Option(short="-A", value_kind=OperandKind.TEXT),
            Option(short="-B", value_kind=OperandKind.TEXT),
            Option(short="-C", value_kind=OperandKind.TEXT),
            Option(long="--hidden"),
            Option(long="--type", value_kind=OperandKind.TEXT),
            Option(long="--glob", value_kind=OperandKind.TEXT),
        ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "sort":
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-n"),
            Option(short="-u"),
            Option(short="-f"),
            Option(short="-k", value_kind=OperandKind.TEXT),
            Option(short="-t", value_kind=OperandKind.TEXT),
            Option(short="-h"),
            Option(short="-V"),
            Option(short="-s"),
            Option(short="-M"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "uniq":
    CommandSpec(
        options=(
            Option(short="-c"),
            Option(short="-d"),
            Option(short="-u"),
            Option(short="-f", value_kind=OperandKind.TEXT),
            Option(short="-s", value_kind=OperandKind.TEXT),
            Option(short="-i"),
            Option(short="-w", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "cut":
    CommandSpec(
        options=(
            Option(short="-f", value_kind=OperandKind.TEXT),
            Option(short="-d", value_kind=OperandKind.TEXT),
            Option(short="-c", value_kind=OperandKind.TEXT),
            Option(long="--complement"),
            Option(short="-z"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "mkdir":
    CommandSpec(
        options=(Option(short="-p"), Option(short="-v")),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "touch":
    CommandSpec(
        options=(
            Option(short="-c"),
            Option(short="-r", value_kind=OperandKind.PATH),
            Option(short="-d", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "cp":
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-R"),
            Option(short="-a"),
            Option(short="-f"),
            Option(short="-n"),
            Option(short="-v"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "mv":
    CommandSpec(
        options=(
            Option(short="-f"),
            Option(short="-n"),
            Option(short="-v"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "rm":
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-R"),
            Option(short="-f"),
            Option(short="-v"),
            Option(short="-d"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "sed":
    CommandSpec(
        options=(
            Option(short="-i"),
            Option(short="-e"),
            Option(short="-n"),
            Option(short="-E"),
        ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "echo":
    CommandSpec(
        options=(Option(short="-n"), Option(short="-e")),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "tee":
    CommandSpec(
        options=(Option(short="-a"), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "tr":
    CommandSpec(
        options=(
            Option(short="-d"),
            Option(short="-s"),
            Option(short="-c"),
        ),
        positional=(
            Operand(kind=OperandKind.TEXT),
            Operand(kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "curl":
    CommandSpec(
        description="Transfer data from or to a server.",
        options=(
            Option(short="-H",
                   value_kind=OperandKind.TEXT,
                   description="Add a header to the request."),
            Option(short="-A",
                   value_kind=OperandKind.TEXT,
                   description="Set the User-Agent header."),
            Option(short="-X",
                   value_kind=OperandKind.TEXT,
                   description="Specify the HTTP request method."),
            Option(short="-d",
                   value_kind=OperandKind.TEXT,
                   description="Send the given body as POST data."),
            Option(short="-F",
                   value_kind=OperandKind.TEXT,
                   description="Submit a multipart/form-data field."),
            Option(short="-o",
                   value_kind=OperandKind.PATH,
                   description="Write output to the given file."),
            Option(short="-L", description="Follow HTTP redirects."),
            Option(short="-s",
                   description="Run silently without progress output."),
            Option(short="-S", description="Show errors even when silent."),
            Option(long="--jina",
                   description="Fetch via the Jina Reader proxy."),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "wget":
    CommandSpec(
        description="Retrieve files from the web.",
        options=(
            Option(
                short="-O",
                value_kind=OperandKind.PATH,
                description="Write the downloaded content to the given file."),
            Option(short="-q", description="Run quietly with no output."),
            Option(
                long="--spider",
                description="Check that the URL exists without downloading it."
            ),
        ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "jq":
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-c"),
            Option(short="-s"),
        ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "awk":
    CommandSpec(
        options=(
            Option(short="-F", value_kind=OperandKind.TEXT),
            Option(short="-v", value_kind=OperandKind.TEXT),
            Option(short="-f", value_kind=OperandKind.PATH),
        ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "paste":
    CommandSpec(
        options=(
            Option(short="-d", value_kind=OperandKind.TEXT),
            Option(short="-s"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "tac":
    CommandSpec(rest=Operand(kind=OperandKind.PATH)),
    "printf":
    CommandSpec(
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "seq":
    CommandSpec(
        description="Print a sequence of numbers.",
        options=(
            Option(
                short="-s",
                value_kind=OperandKind.TEXT,
                description=("Use the given string as separator "
                             "between numbers."),
            ),
            Option(short="-w",
                   value_kind=OperandKind.TEXT,
                   description="Pad numbers with zeros to equal width."),
            Option(
                short="-f",
                value_kind=OperandKind.TEXT,
                description=("Format each number with a printf-style "
                             "format string."),
            ),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "base64":
    CommandSpec(
        options=(
            Option(short="-d"),
            Option(short="-D"),
            Option(short="-w", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "sha256sum":
    CommandSpec(
        options=(Option(short="-c"), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "xxd":
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-p"),
            Option(short="-l", value_kind=OperandKind.TEXT),
            Option(short="-c", value_kind=OperandKind.TEXT),
            Option(short="-s", value_kind=OperandKind.TEXT),
            Option(short="-g", value_kind=OperandKind.TEXT),
            Option(short="-u"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "tar":
    CommandSpec(
        options=(
            Option(short="-c"),
            Option(short="-x"),
            Option(short="-t"),
            Option(short="-z"),
            Option(short="-j"),
            Option(short="-J"),
            Option(short="-v"),
            Option(short="-f", value_kind=OperandKind.PATH),
            Option(short="-C", value_kind=OperandKind.PATH),
            Option(long="--strip-components", value_kind=OperandKind.TEXT),
            Option(long="--exclude", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "gzip":
    CommandSpec(
        options=(
            Option(short="-d"),
            Option(short="-k"),
            Option(short="-f"),
            Option(short="-c"),
            Option(short="-1"),
            Option(short="-2"),
            Option(short="-3"),
            Option(short="-4"),
            Option(short="-5"),
            Option(short="-6"),
            Option(short="-7"),
            Option(short="-8"),
            Option(short="-9"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "gunzip":
    CommandSpec(
        options=(
            Option(short="-k"),
            Option(short="-f"),
            Option(short="-c"),
            Option(short="-t"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "zip":
    CommandSpec(
        options=(
            Option(short="-r"),
            Option(short="-j"),
            Option(short="-q"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "unzip":
    CommandSpec(
        options=(
            Option(short="-o"),
            Option(short="-l"),
            Option(short="-d", value_kind=OperandKind.PATH),
            Option(short="-q"),
            Option(short="-p"),
            Option(short="-t"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "basename":
    CommandSpec(rest=Operand(kind=OperandKind.TEXT)),
    "dirname":
    CommandSpec(rest=Operand(kind=OperandKind.TEXT)),
    "realpath":
    CommandSpec(
        options=(
            Option(short="-e"),
            Option(short="-m"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "readlink":
    CommandSpec(
        options=(
            Option(short="-f"),
            Option(short="-e"),
            Option(short="-m"),
            Option(short="-n"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "ln":
    CommandSpec(
        options=(
            Option(short="-s"),
            Option(short="-f"),
            Option(short="-n"),
            Option(short="-v"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "split":
    CommandSpec(
        options=(
            Option(short="-l", value_kind=OperandKind.TEXT),
            Option(short="-b", value_kind=OperandKind.TEXT),
            Option(short="-n", value_kind=OperandKind.TEXT),
            Option(short="-d"),
            Option(short="-a", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "patch":
    CommandSpec(
        options=(
            Option(short="-p", value_kind=OperandKind.TEXT),
            Option(short="-R"),
            Option(short="-i", value_kind=OperandKind.PATH),
            Option(short="-N"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "shuf":
    CommandSpec(
        options=(
            Option(short="-n", value_kind=OperandKind.TEXT),
            Option(short="-e"),
            Option(short="-z"),
            Option(short="-r"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "comm":
    CommandSpec(
        options=(
            Option(short="-1"),
            Option(short="-2"),
            Option(short="-3"),
            Option(long="--check-order"),
            Option(long="--nocheck-order"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "column":
    CommandSpec(
        options=(
            Option(short="-t"),
            Option(short="-s", value_kind=OperandKind.TEXT),
            Option(short="-o", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "fold":
    CommandSpec(
        options=(
            Option(short="-w", value_kind=OperandKind.TEXT),
            Option(short="-s"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "fmt":
    CommandSpec(
        options=(Option(short="-w", value_kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "cmp":
    CommandSpec(
        options=(
            Option(short="-l"),
            Option(short="-s"),
            Option(short="-n", value_kind=OperandKind.TEXT),
            Option(short="-b"),
            Option(short="-i", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "iconv":
    CommandSpec(
        options=(
            Option(short="-f", value_kind=OperandKind.TEXT),
            Option(short="-t", value_kind=OperandKind.TEXT),
            Option(short="-c"),
            Option(short="-o", value_kind=OperandKind.PATH),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "strings":
    CommandSpec(
        options=(Option(short="-n", value_kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "rev":
    CommandSpec(rest=Operand(kind=OperandKind.PATH)),
    "zcat":
    CommandSpec(rest=Operand(kind=OperandKind.PATH)),
    "zgrep":
    CommandSpec(
        options=(
            Option(short="-i"),
            Option(short="-c"),
            Option(short="-l"),
            Option(short="-n"),
            Option(short="-v"),
            Option(short="-e", value_kind=OperandKind.TEXT),
            Option(short="-E"),
            Option(short="-F"),
            Option(short="-H"),
            Option(short="-h"),
            Option(short="-m", value_kind=OperandKind.TEXT),
            Option(short="-o"),
            Option(short="-q"),
            Option(short="-w"),
        ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "mktemp":
    CommandSpec(
        options=(
            Option(short="-d"),
            Option(short="-p", value_kind=OperandKind.TEXT),
            Option(short="-t"),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "bc":
    CommandSpec(
        description="Arbitrary precision calculator language.",
        options=(
            Option(short="-l", description="Load the standard math library."),
            Option(short="-q", description="Suppress the welcome banner."),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "expr":
    CommandSpec(
        description="Evaluate expressions.",
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "history":
    CommandSpec(
        description="Show command history for the session.",
        options=(Option(short="-c",
                        description="Clear the command history."), ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "date":
    CommandSpec(
        description="Print or set the system date and time.",
        options=(
            Option(
                short="-d",
                value_kind=OperandKind.TEXT,
                description=("Display the time described by the given "
                             "date string."),
            ),
            Option(short="-u",
                   description="Use Coordinated Universal Time (UTC)."),
            Option(short="-I", description="Output date in ISO 8601 format."),
            Option(short="-R",
                   description="Output date in RFC 5322 email format."),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "csplit":
    CommandSpec(
        options=(
            Option(short="-f", value_kind=OperandKind.TEXT),
            Option(short="-n", value_kind=OperandKind.TEXT),
            Option(short="-b", value_kind=OperandKind.TEXT),
            Option(short="-k"),
            Option(short="-s"),
        ),
        positional=(Operand(kind=OperandKind.PATH), ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "expand":
    CommandSpec(
        options=(
            Option(short="-t", value_kind=OperandKind.TEXT),
            Option(short="-i"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "unexpand":
    CommandSpec(
        options=(
            Option(short="-t", value_kind=OperandKind.TEXT),
            Option(short="-a"),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "tsort":
    CommandSpec(rest=Operand(kind=OperandKind.PATH)),
    "look":
    CommandSpec(
        options=(Option(short="-f"), ),
        positional=(Operand(kind=OperandKind.TEXT), ),
        rest=Operand(kind=OperandKind.PATH),
    ),
    "sleep":
    CommandSpec(
        description="Delay for a specified amount of time.",
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "bash":
    CommandSpec(
        description=("Run a command string through Mirage's shell. "
                     "Only `-c` is meaningful; other flags are accepted "
                     "and ignored. `bash` and `sh` are aliases."),
        options=(
            Option(
                short="-c",
                value_kind=OperandKind.TEXT,
                description=("Read commands from the next argument "
                             "and execute them."),
            ),
            Option(
                short="-s",
                description=("Read commands from stdin instead of "
                             "from an argument."),
            ),
            Option(short="-l",
                   description=("(Ignored) Login shell. Mirage does "
                                "not source profile files.")),
            Option(short="-i",
                   description=("(Ignored) Interactive flag. Mirage "
                                "shells are non-interactive.")),
            Option(short="-e", description="(Ignored) Exit on first error."),
            Option(short="-u",
                   description="(Ignored) Treat unset variables as errors."),
            Option(short="-x",
                   description="(Ignored) Print commands as they execute."),
            Option(long="--login", description="(Ignored) Login shell."),
            Option(long="--norc", description="(Ignored) Skip rc files."),
            Option(long="--noprofile",
                   description="(Ignored) Skip profile files."),
            Option(long="--posix",
                   description="(Ignored) POSIX-conformant mode."),
        ),
        rest=Operand(kind=OperandKind.TEXT),
    ),
    "join":
    CommandSpec(
        options=(
            Option(short="-t", value_kind=OperandKind.TEXT),
            Option(short="-1", value_kind=OperandKind.TEXT),
            Option(short="-2", value_kind=OperandKind.TEXT),
            Option(short="-a", value_kind=OperandKind.TEXT),
            Option(short="-v", value_kind=OperandKind.TEXT),
            Option(short="-e", value_kind=OperandKind.TEXT),
            Option(short="-o", value_kind=OperandKind.TEXT),
        ),
        rest=Operand(kind=OperandKind.PATH),
    ),
}
