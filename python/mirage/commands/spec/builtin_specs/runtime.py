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

from mirage.commands.spec.types import Argument, CommandSpec

# CPython's own option table, minus four switches that describe a
# process mirage does not have: -i (drop to an interactive prompt), -d
# (parser debug, a debug-build-only switch), -v (trace every import to
# stderr) and the --help-env/--help-xoptions/--help-all dumps, which
# document a CPython build rather than this command. Everything else
# CPython accepts, this accepts.
#
# The four groups differ in who answers them: -c/-m select the source
# and end option parsing (their argument is a program, so trailing
# words are that program's argv); -x also selects source, by dropping
# the script file's first line, and is answered here rather than by a
# runtime because every engine reads the same resolved text; the init
# switches are handed to the runtime through RunArgs.flags and honored
# by whichever engine can; -u is a structural no-op, since mirage
# buffers every stream and returns it whole. Pinned against CPython
# 3.12.11.
_PYTHON_OPTIONS: tuple[Argument, ...] = (
    Argument("-c", help="Run the next argument as a program."),
    Argument("-m", help="Run the named module as __main__."),
    Argument(
        "-u",
        action="store_true",
        help="(Ignored) Unbuffered output. Mirage buffers "
        "every stream and returns it whole.",
    ),
    Argument(
        "-b",
        action="count",
        help="Warn on str(bytes) and on comparing bytes with "
        "str; -bb raises instead.",
    ),
    Argument(
        "-B", action="store_true", help="Do not write .pyc files on import."
    ),
    Argument(
        "-E", action="store_true", help="Ignore PYTHON* environment variables."
    ),
    Argument(
        "-I", action="store_true", help="Isolated mode: implies -E and -s."
    ),
    Argument(
        "-O",
        action="count",
        help="Remove assert and __debug__ blocks; -OO also strips docstrings.",
    ),
    Argument(
        "-P",
        action="store_true",
        help="Do not prepend the script's directory to sys.path.",
    ),
    Argument(
        "-q",
        action="store_true",
        help="(Ignored) Suppress the version banner. Mirage prints none.",
    ),
    Argument(
        "-s",
        action="store_true",
        help="Do not add the user site directory to sys.path.",
    ),
    Argument(
        "-S",
        action="store_true",
        help="Do not run 'import site' on initialization.",
    ),
    Argument("-W", action="append", help="Set a warning control filter."),
    Argument(
        "-x",
        action="store_true",
        help="Skip the script file's first line, for a non-Unix #! form.",
    ),
    Argument(
        "-X",
        action="append",
        help="Set an implementation-specific option.",
    ),
    # CPython parses this one by hand and so rejects the --opt=value
    # spelling it accepts everywhere else; mirage's parser takes both,
    # which is the harmless direction to diverge in.
    Argument(
        "--check-hash-based-pycs",
        choices=("always", "default", "never"),
        help="How to validate hash-based .pyc files.",
    ),
    # -VV shares the concise version line; build details are not exposed.
    Argument(
        "-h",
        "--help",
        action="store_true",
        help="Show this help message and exit.",
    ),
    Argument(
        "-V",
        "--version",
        action="store_true",
        help="Show version information and exit.",
    ),
)

# CPython's own synopsis, `[-c cmd | -m mod | file | -] [arg] ...`: the
# first operand is a file the interpreter reads, unless a -c or -m
# already named the program, and the words after it are the program's
# argv. The slot has to say so, because a runtime that reads the script
# itself (a sandbox, a host process) is outside every dispatcher, so the
# admission gate is the one place a path rule can see the file.
_PYTHON_SCRIPT = Argument(
    "path", type="path", nargs="?", metavar="", provided_by=("-c", "-m")
)

# node's `[script.js | -e "script" | -] [arguments]`, the same shape.
_JS_SCRIPT = Argument(
    "path", type="path", nargs="?", metavar="", provided_by=("-e",)
)

SPECS: dict[str, CommandSpec] = {
    "python": CommandSpec(
        description="Run Python on the workspace's bound runtime.",
        arguments=(
            *_PYTHON_OPTIONS,
            _PYTHON_SCRIPT,
            Argument("texts", nargs="REMAINDER", metavar=""),
        ),
    ),
    "python3": CommandSpec(
        description="Run Python on the workspace's bound runtime.",
        arguments=(
            *_PYTHON_OPTIONS,
            _PYTHON_SCRIPT,
            Argument("texts", nargs="REMAINDER", metavar=""),
        ),
    ),
    # js and node take the remainder for the same reason python does: the
    # first operand is a program, so the words after it are that program's
    # argv, not the interpreter's flags. `node - -e x` runs the piped
    # program and hands it `-e x`; `node s.js -m` hands s.js its own -m.
    # Pinned against node 22.8.0.
    "js": CommandSpec(
        description="Run JavaScript on a sandboxed quickjs engine.",
        arguments=(
            Argument(
                "-v",
                "--version",
                action="store_true",
                help="Show runtime version information and exit.",
            ),
            Argument(
                "-e",
                help="Evaluate the next argument as a script.",
            ),
            Argument(
                "-m",
                "--module",
                action="store_true",
                help="Run as an ES module (top-level "
                "import/export/await); .mjs files "
                "select this automatically.",
            ),
            _JS_SCRIPT,
            Argument("texts", nargs="REMAINDER", metavar=""),
        ),
    ),
    "node": CommandSpec(
        description="Run JavaScript on a sandboxed quickjs engine.",
        arguments=(
            Argument(
                "-v",
                "--version",
                action="store_true",
                help="Show runtime version information and exit.",
            ),
            Argument(
                "-e",
                help="Evaluate the next argument as a script.",
            ),
            Argument(
                "-m",
                "--module",
                action="store_true",
                help="Run as an ES module (top-level "
                "import/export/await); .mjs files "
                "select this automatically.",
            ),
            _JS_SCRIPT,
            Argument("texts", nargs="REMAINDER", metavar=""),
        ),
    ),
    "mktemp": CommandSpec(
        arguments=(
            Argument("-d", "--directory", action="store_true"),
            Argument("-p", type="path"),
            Argument("--tmpdir", type="path", nargs="?", attached_only=True),
            Argument("-t", action="store_true"),
            Argument("-u", "--dry-run", action="store_true"),
            Argument("-q", "--quiet", action="store_true"),
            Argument("--suffix"),
            Argument("text", nargs="?", metavar=""),
        )
    ),
    "bc": CommandSpec(
        description="Arbitrary precision calculator language.",
        arguments=(
            Argument(
                "-l",
                action="store_true",
                help="Load the standard math library.",
            ),
            Argument(
                "-q", action="store_true", help="Suppress the welcome banner."
            ),
            Argument("texts", nargs="*", metavar=""),
        ),
    ),
    "expr": CommandSpec(
        description="Evaluate expressions.",
        arguments=(Argument("texts", nargs="*", metavar=""),),
    ),
    "history": CommandSpec(
        description="Show command history for the session.",
        arguments=(
            Argument(
                "-c", action="store_true", help="Clear the command history."
            ),
            Argument(
                "-d",
                help="Delete the entry at the given position; "
                "negative counts back from the end.",
            ),
            Argument(
                "-s",
                action="store_true",
                help="Append the args to the history as a "
                "single entry without executing them.",
            ),
            Argument(
                "-p",
                action="store_true",
                help="Print the args without storing them.",
            ),
            Argument(
                "-a",
                action="store_true",
                help="Append: no-op (file and store are the same).",
            ),
            Argument(
                "-r",
                action="store_true",
                help="Read: no-op (file and store are the same).",
            ),
            Argument(
                "-w",
                action="store_true",
                help="Write: no-op (file and store are the same).",
            ),
            Argument(
                "-n",
                action="store_true",
                help="Read-new: no-op (file and store are the same).",
            ),
            Argument("texts", nargs="*", metavar=""),
        ),
    ),
    "date": CommandSpec(
        description="Print or set the system date and time.",
        arguments=(
            Argument(
                "-d",
                "--date",
                help="Display the time described by the given date string.",
            ),
            # GNU -I[FMT]: the precision rides attached (-Is) or after
            # `=`, never as the next word, and matches by prefix in
            # GNU's own table order.
            Argument(
                "-I",
                "--iso-8601",
                nargs="?",
                attached_only=True,
                choices=("hours", "minutes", "date", "seconds", "ns"),
                help="Output date/time in ISO 8601 format, to "
                "the given precision (default date).",
            ),
            Argument(
                "-R",
                "--rfc-email",
                action="store_true",
                help="Output date in RFC 5322 email format.",
            ),
            Argument(
                "--rfc-3339",
                choices=("date", "seconds", "ns"),
                help="Output date/time in RFC 3339 format, to "
                "the given precision.",
            ),
            Argument(
                "-u",
                "--utc",
                action="store_true",
                help="Use Coordinated Universal Time (UTC).",
            ),
            Argument(
                "--universal",
                action="store_true",
                help="Use Coordinated Universal Time (UTC).",
            ),
            Argument("text", nargs="?", metavar=""),
        ),
    ),
    "uname": CommandSpec(
        description="Print certain system information.",
        arguments=(
            Argument(
                "-a",
                "--all",
                action="store_true",
                help="Print all information, omitting -p and -i if unknown.",
            ),
            Argument(
                "-s",
                "--kernel-name",
                action="store_true",
                help="Print the kernel name.",
            ),
            Argument(
                "-n",
                "--nodename",
                action="store_true",
                help="Print the network node hostname.",
            ),
            Argument(
                "-r",
                "--kernel-release",
                action="store_true",
                help="Print the kernel release.",
            ),
            Argument(
                "-v",
                "--kernel-version",
                action="store_true",
                help="Print the kernel version.",
            ),
            Argument(
                "-m",
                "--machine",
                action="store_true",
                help="Print the machine hardware name.",
            ),
            Argument(
                "-p",
                "--processor",
                action="store_true",
                help="Print the processor type.",
            ),
            Argument(
                "-i",
                "--hardware-platform",
                action="store_true",
                help="Print the hardware platform.",
            ),
            Argument(
                "-o",
                "--operating-system",
                action="store_true",
                help="Print the operating system.",
            ),
            Argument("texts", nargs="*", metavar=""),
        ),
    ),
    "hostname": CommandSpec(
        description="Show or set the system's host name.",
        arguments=(
            Argument(
                "-a", "--alias", action="store_true", help="Alias names."
            ),
            Argument(
                "-A",
                "--all-fqdns",
                action="store_true",
                help="All long host names (FQDNs).",
            ),
            Argument(
                "-b",
                "--boot",
                action="store_true",
                help="Set default hostname if none available.",
            ),
            Argument(
                "-d", "--domain", action="store_true", help="DNS domain name."
            ),
            Argument(
                "-f",
                "--fqdn",
                action="store_true",
                help="Long host name (FQDN).",
            ),
            Argument(
                "--long", action="store_true", help="Long host name (FQDN)."
            ),
            Argument(
                "-F",
                "--file",
                help="Read host name or NIS domain name from given file.",
            ),
            Argument(
                "-i",
                "--ip-address",
                action="store_true",
                help="Addresses for the host name.",
            ),
            Argument(
                "-I",
                "--all-ip-addresses",
                action="store_true",
                help="All addresses for the host.",
            ),
            Argument(
                "-s", "--short", action="store_true", help="Short host name."
            ),
            Argument(
                "-y", "--yp", action="store_true", help="NIS/YP domain name."
            ),
            Argument("--nis", action="store_true", help="NIS/YP domain name."),
            Argument("texts", nargs="*", metavar=""),
        ),
    ),
    "id": CommandSpec(
        description="Print user and group information for each specified "
        "USER, or (when USER omitted) for the current process.",
        arguments=(
            Argument(
                "-a",
                action="store_true",
                help="Ignore, for compatibility with other versions.",
            ),
            Argument(
                "-Z",
                "--context",
                action="store_true",
                help="Print only the security context of the process.",
            ),
            Argument(
                "-g",
                "--group",
                action="store_true",
                help="Print only the effective group ID.",
            ),
            Argument(
                "-G",
                "--groups",
                action="store_true",
                help="Print all group IDs.",
            ),
            Argument(
                "-n",
                "--name",
                action="store_true",
                help="Print a name instead of a number, for -u,-g,-G.",
            ),
            Argument(
                "-r",
                "--real",
                action="store_true",
                help="Print the real ID instead of the effective ID, "
                "with -u,-g,-G.",
            ),
            Argument(
                "-u",
                "--user",
                action="store_true",
                help="Print only the effective user ID.",
            ),
            Argument(
                "-z",
                "--zero",
                action="store_true",
                help="Delimit entries with NUL characters, not "
                "whitespace; not permitted in default format.",
            ),
            Argument("texts", nargs="*", metavar=""),
        ),
    ),
    "getconf": CommandSpec(
        description="Get the configuration value for variable VAR, or for "
        "variable PATH_VAR for path PATH.",
        arguments=(
            Argument(
                "-a",
                action="store_true",
                help="Print every variable and its value.",
            ),
            Argument(
                "-v",
                help="Give values for compilation environment SPEC.",
            ),
            Argument("texts", nargs="*", metavar=""),
        ),
    ),
    "sleep": CommandSpec(
        description="Delay for a specified amount of time.",
        arguments=(Argument("texts", nargs="*", metavar=""),),
    ),
    "bash": CommandSpec(
        description="Run a program in a nested Mirage shell: the text after `-c`, "
        "a script file, or standard input. `bash` and `sh` are aliases.",
        arguments=(
            Argument(
                "-c",
                help="Read commands from the next argument and execute them.",
            ),
            Argument(
                "-s",
                action="store_true",
                help="Read commands from stdin instead of from an argument.",
            ),
            Argument(
                "-l",
                action="store_true",
                help="(Ignored) Login shell. Mirage does "
                "not source profile files.",
            ),
            Argument(
                "-i",
                action="store_true",
                help="(Ignored) Interactive flag. Mirage "
                "shells are non-interactive.",
            ),
            Argument("-e", action="store_true", help="Exit on first error."),
            Argument(
                "-u",
                action="store_true",
                help="Treat unset variables as errors.",
            ),
            Argument(
                "-x",
                action="store_true",
                help="Print commands as they execute.",
            ),
            Argument(
                "--debug",
                action="store_true",
                help="(Ignored) Debugging mode.",
            ),
            Argument(
                "--init-file",
                help="(Ignored) Read this file instead of ~/.bashrc.",
            ),
            Argument(
                "--login", action="store_true", help="(Ignored) Login shell."
            ),
            Argument(
                "--noediting",
                action="store_true",
                help="(Ignored) No line editing.",
            ),
            Argument(
                "--noprofile",
                action="store_true",
                help="(Ignored) Skip profile files.",
            ),
            Argument(
                "--norc", action="store_true", help="(Ignored) Skip rc files."
            ),
            Argument(
                "--posix",
                action="store_true",
                help="(Ignored) POSIX-conformant mode.",
            ),
            Argument(
                "--rcfile",
                help="(Ignored) Read this file instead of ~/.bashrc.",
            ),
            Argument(
                "--verbose",
                action="store_true",
                help="Print input lines as they are read.",
            ),
            Argument("texts", nargs="*", metavar=""),
        ),
    ),
}
