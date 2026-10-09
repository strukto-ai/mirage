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

from mirage.commands.spec.types import CommandSpec, Operand, Option

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
_PYTHON_OPTIONS: tuple[Option, ...] = (
    Option(
        short="-c",
        type="str",
        description="Run the next argument as a program.",
    ),
    Option(
        short="-m", type="str", description="Run the named module as __main__."
    ),
    Option(
        short="-u",
        description=(
            "(Ignored) Unbuffered output. Mirage buffers "
            "every stream and returns it whole."
        ),
    ),
    Option(
        short="-b",
        count=True,
        description=(
            "Warn on str(bytes) and on comparing bytes with "
            "str; -bb raises instead."
        ),
    ),
    Option(short="-B", description="Do not write .pyc files on import."),
    Option(short="-E", description="Ignore PYTHON* environment variables."),
    Option(short="-I", description="Isolated mode: implies -E and -s."),
    Option(
        short="-O",
        count=True,
        description=(
            "Remove assert and __debug__ blocks; -OO also strips docstrings."
        ),
    ),
    Option(
        short="-P",
        description=("Do not prepend the script's directory to sys.path."),
    ),
    Option(
        short="-q",
        description=(
            "(Ignored) Suppress the version banner. Mirage prints none."
        ),
    ),
    Option(
        short="-s",
        description="Do not add the user site directory to sys.path.",
    ),
    Option(
        short="-S", description="Do not run 'import site' on initialization."
    ),
    Option(
        short="-W",
        type="str",
        multiple=True,
        description="Set a warning control filter.",
    ),
    Option(
        short="-x",
        description=(
            "Skip the script file's first line, for a non-Unix #! form."
        ),
    ),
    Option(
        short="-X",
        type="str",
        multiple=True,
        description="Set an implementation-specific option.",
    ),
    # CPython parses this one by hand and so rejects the --opt=value
    # spelling it accepts everywhere else; mirage's parser takes both,
    # which is the harmless direction to diverge in.
    Option(
        long="--check-hash-based-pycs",
        type="str",
        choices=("always", "default", "never"),
        description="How to validate hash-based .pyc files.",
    ),
    # -VV shares the concise version line; build details are not exposed.
    Option(
        short="-h",
        long="--help",
        description="Show this help message and exit.",
    ),
    Option(
        short="-V",
        long="--version",
        description="Show version information and exit.",
    ),
)

# CPython's own synopsis, `[-c cmd | -m mod | file | -] [arg] ...`: the
# first operand is a file the interpreter reads, unless a -c or -m
# already named the program, and the words after it are the program's
# argv. The slot has to say so, because a runtime that reads the script
# itself (a sandbox, a host process) is outside every dispatcher, so the
# admission gate is the one place a path rule can see the file.
_PYTHON_SCRIPT = Operand(type="path", provided_by=("-c", "-m"))

# node's `[script.js | -e "script" | -] [arguments]`, the same shape.
_JS_SCRIPT = Operand(type="path", provided_by=("-e",))

SPECS: dict[str, CommandSpec] = {
    "python": CommandSpec(
        description="Run Python on the workspace's bound runtime.",
        options=_PYTHON_OPTIONS,
        positional=(_PYTHON_SCRIPT,),
        rest=Operand(type="str", remainder=True),
    ),
    "python3": CommandSpec(
        description="Run Python on the workspace's bound runtime.",
        options=_PYTHON_OPTIONS,
        positional=(_PYTHON_SCRIPT,),
        rest=Operand(type="str", remainder=True),
    ),
    # js and node take the remainder for the same reason python does: the
    # first operand is a program, so the words after it are that program's
    # argv, not the interpreter's flags. `node - -e x` runs the piped
    # program and hands it `-e x`; `node s.js -m` hands s.js its own -m.
    # Pinned against node 22.8.0.
    "js": CommandSpec(
        description="Run JavaScript on a sandboxed quickjs engine.",
        options=(
            Option(
                short="-v",
                long="--version",
                description="Show runtime version information and exit.",
            ),
            Option(
                short="-e",
                type="str",
                description="Evaluate the next argument as a script.",
            ),
            Option(
                short="-m",
                long="--module",
                description=(
                    "Run as an ES module (top-level "
                    "import/export/await); .mjs files "
                    "select this automatically."
                ),
            ),
        ),
        positional=(_JS_SCRIPT,),
        rest=Operand(type="str", remainder=True),
    ),
    "node": CommandSpec(
        description="Run JavaScript on a sandboxed quickjs engine.",
        options=(
            Option(
                short="-v",
                long="--version",
                description="Show runtime version information and exit.",
            ),
            Option(
                short="-e",
                type="str",
                description="Evaluate the next argument as a script.",
            ),
            Option(
                short="-m",
                long="--module",
                description=(
                    "Run as an ES module (top-level "
                    "import/export/await); .mjs files "
                    "select this automatically."
                ),
            ),
        ),
        positional=(_JS_SCRIPT,),
        rest=Operand(type="str", remainder=True),
    ),
    "mktemp": CommandSpec(
        options=(
            Option(short="-d", long="--directory"),
            Option(short="-p", type="path"),
            Option(long="--tmpdir", type="path", value_optional=True),
            Option(short="-t"),
            Option(short="-u", long="--dry-run"),
            Option(short="-q", long="--quiet"),
            Option(long="--suffix", type="str"),
        ),
        positional=(Operand(type="str"),),
    ),
    "bc": CommandSpec(
        description="Arbitrary precision calculator language.",
        options=(
            Option(short="-l", description="Load the standard math library."),
            Option(short="-q", description="Suppress the welcome banner."),
        ),
        rest=Operand(type="str"),
    ),
    "expr": CommandSpec(
        description="Evaluate expressions.",
        rest=Operand(type="str"),
    ),
    "history": CommandSpec(
        description="Show command history for the session.",
        options=(
            Option(short="-c", description="Clear the command history."),
            Option(
                short="-d",
                type="str",
                description=(
                    "Delete the entry at the given position; "
                    "negative counts back from the end."
                ),
            ),
            Option(
                short="-s",
                description=(
                    "Append the args to the history as a "
                    "single entry without executing them."
                ),
            ),
            Option(
                short="-p", description="Print the args without storing them."
            ),
            Option(
                short="-a",
                description=("Append: no-op (file and store are the same)."),
            ),
            Option(
                short="-r",
                description=("Read: no-op (file and store are the same)."),
            ),
            Option(
                short="-w",
                description=("Write: no-op (file and store are the same)."),
            ),
            Option(
                short="-n",
                description=("Read-new: no-op (file and store are the same)."),
            ),
        ),
        rest=Operand(type="str"),
    ),
    "date": CommandSpec(
        description="Print or set the system date and time.",
        options=(
            Option(
                short="-d",
                long="--date",
                type="str",
                description=(
                    "Display the time described by the given date string."
                ),
            ),
            # GNU -I[FMT]: the precision rides attached (-Is) or after
            # `=`, never as the next word, and matches by prefix in
            # GNU's own table order.
            Option(
                short="-I",
                long="--iso-8601",
                type="str",
                value_optional=True,
                choices=("hours", "minutes", "date", "seconds", "ns"),
                description=(
                    "Output date/time in ISO 8601 format, to "
                    "the given precision (default date)."
                ),
            ),
            Option(
                short="-R",
                long="--rfc-email",
                description="Output date in RFC 5322 email format.",
            ),
            Option(
                long="--rfc-3339",
                type="str",
                choices=("date", "seconds", "ns"),
                description=(
                    "Output date/time in RFC 3339 format, to "
                    "the given precision."
                ),
            ),
            Option(
                short="-u",
                long="--utc",
                description="Use Coordinated Universal Time (UTC).",
            ),
            Option(
                long="--universal",
                description="Use Coordinated Universal Time (UTC).",
            ),
        ),
        positional=(Operand(type="str"),),
    ),
    "uname": CommandSpec(
        description="Print certain system information.",
        options=(
            Option(
                short="-a",
                long="--all",
                description=(
                    "Print all information, omitting -p and -i if unknown."
                ),
            ),
            Option(
                short="-s",
                long="--kernel-name",
                description="Print the kernel name.",
            ),
            Option(
                short="-n",
                long="--nodename",
                description="Print the network node hostname.",
            ),
            Option(
                short="-r",
                long="--kernel-release",
                description="Print the kernel release.",
            ),
            Option(
                short="-v",
                long="--kernel-version",
                description="Print the kernel version.",
            ),
            Option(
                short="-m",
                long="--machine",
                description="Print the machine hardware name.",
            ),
            Option(
                short="-p",
                long="--processor",
                description="Print the processor type.",
            ),
            Option(
                short="-i",
                long="--hardware-platform",
                description="Print the hardware platform.",
            ),
            Option(
                short="-o",
                long="--operating-system",
                description="Print the operating system.",
            ),
        ),
        rest=Operand(type="str"),
    ),
    "hostname": CommandSpec(
        description="Show or set the system's host name.",
        options=(
            Option(short="-a", long="--alias", description="Alias names."),
            Option(
                short="-A",
                long="--all-fqdns",
                description="All long host names (FQDNs).",
            ),
            Option(
                short="-b",
                long="--boot",
                description="Set default hostname if none available.",
            ),
            Option(
                short="-d", long="--domain", description="DNS domain name."
            ),
            Option(
                short="-f",
                long="--fqdn",
                description="Long host name (FQDN).",
            ),
            Option(long="--long", description="Long host name (FQDN)."),
            Option(
                short="-F",
                long="--file",
                type="str",
                description="Read host name or NIS domain name from given "
                "file.",
            ),
            Option(
                short="-i",
                long="--ip-address",
                description="Addresses for the host name.",
            ),
            Option(
                short="-I",
                long="--all-ip-addresses",
                description="All addresses for the host.",
            ),
            Option(short="-s", long="--short", description="Short host name."),
            Option(short="-y", long="--yp", description="NIS/YP domain name."),
            Option(long="--nis", description="NIS/YP domain name."),
        ),
        rest=Operand(type="str"),
    ),
    "id": CommandSpec(
        description="Print user and group information for each specified "
        "USER, or (when USER omitted) for the current process.",
        options=(
            Option(
                short="-a",
                description="Ignore, for compatibility with other versions.",
            ),
            Option(
                short="-Z",
                long="--context",
                description="Print only the security context of the process.",
            ),
            Option(
                short="-g",
                long="--group",
                description="Print only the effective group ID.",
            ),
            Option(
                short="-G", long="--groups", description="Print all group IDs."
            ),
            Option(
                short="-n",
                long="--name",
                description="Print a name instead of a number, for -u,-g,-G.",
            ),
            Option(
                short="-r",
                long="--real",
                description="Print the real ID instead of the effective ID, "
                "with -u,-g,-G.",
            ),
            Option(
                short="-u",
                long="--user",
                description="Print only the effective user ID.",
            ),
            Option(
                short="-z",
                long="--zero",
                description="Delimit entries with NUL characters, not "
                "whitespace; not permitted in default format.",
            ),
        ),
        rest=Operand(type="str"),
    ),
    "getconf": CommandSpec(
        description="Get the configuration value for variable VAR, or for "
        "variable PATH_VAR for path PATH.",
        options=(
            Option(
                short="-a",
                description="Print every variable and its value.",
            ),
            Option(
                short="-v",
                type="str",
                description="Give values for compilation environment SPEC.",
            ),
        ),
        rest=Operand(type="str"),
    ),
    "sleep": CommandSpec(
        description="Delay for a specified amount of time.",
        rest=Operand(type="str"),
    ),
    "bash": CommandSpec(
        description=(
            "Run a program in a nested Mirage shell: the text after `-c`, "
            "a script file, or standard input. `bash` and `sh` are aliases."
        ),
        options=(
            Option(
                short="-c",
                type="str",
                description=(
                    "Read commands from the next argument and execute them."
                ),
            ),
            Option(
                short="-s",
                description=(
                    "Read commands from stdin instead of from an argument."
                ),
            ),
            Option(
                short="-l",
                description=(
                    "(Ignored) Login shell. Mirage does "
                    "not source profile files."
                ),
            ),
            Option(
                short="-i",
                description=(
                    "(Ignored) Interactive flag. Mirage "
                    "shells are non-interactive."
                ),
            ),
            Option(short="-e", description="Exit on first error."),
            Option(
                short="-u",
                description="Treat unset variables as errors.",
            ),
            Option(
                short="-x",
                description="Print commands as they execute.",
            ),
            Option(long="--debug", description="(Ignored) Debugging mode."),
            Option(
                long="--init-file",
                type="str",
                description="(Ignored) Read this file instead of ~/.bashrc.",
            ),
            Option(long="--login", description="(Ignored) Login shell."),
            Option(
                long="--noediting", description="(Ignored) No line editing."
            ),
            Option(
                long="--noprofile", description="(Ignored) Skip profile files."
            ),
            Option(long="--norc", description="(Ignored) Skip rc files."),
            Option(
                long="--posix", description="(Ignored) POSIX-conformant mode."
            ),
            Option(
                long="--rcfile",
                type="str",
                description="(Ignored) Read this file instead of ~/.bashrc.",
            ),
            Option(
                long="--verbose",
                description="Print input lines as they are read.",
            ),
        ),
        rest=Operand(type="str"),
    ),
}
