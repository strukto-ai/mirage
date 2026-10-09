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

from mirage.runtime.types import RunArgs

PAYLOAD_ARGV0 = "-c"
STDIN_ARGV0 = "-"
STDIN_FILENAME = "<stdin>"


def main_filename(args: RunArgs) -> str | None:
    """The file CPython runs a program from, named the way it names it.

    A script and a program piped to stdin both come through CPython's
    file adapter, which binds ``__file__`` to the file's name and compiles
    every frame under it: the script operand made absolute against the
    working directory as typed, never normalized (``./s.py`` under /w
    is ``/w/./s.py``), or ``<stdin>`` for either stdin spelling. A
    payload, a module and a script CLI come through no file. Pinned on
    CPython 3.13.5.

    Args:
        args (RunArgs): the run, whose ``script_path`` and ``prog`` say
            which entry point the source came through.
    """
    script = args.script_path
    if script is None:
        return STDIN_FILENAME if args.prog in ("", STDIN_ARGV0) else None
    typed = script.raw_path or script.virtual
    if typed.startswith("/"):
        return typed
    if args.cwd is None:
        return script.virtual
    return f"{args.cwd.virtual.rstrip('/')}/{typed}"


def prepare_source(args: RunArgs, *, search_path: bool = False) -> str:
    """Wrap a program so a `-c` subprocess runs it the way CPython would.

    The subprocess tiers hand CPython the program through `-c`, because
    the source comes off a mount and may not exist on the host at all.
    CPython then hardcodes argv[0] to "-c", names every frame "<string>"
    and binds no ``__file__``, which is right for a payload and wrong for
    the other three entry points: a script must see its own path in argv[0] and
    ``__file__``, and its own name in a traceback.

    Re-compiling under the real name fixes the frames, and the preamble
    binds only what CPython's own file adapter binds (``__file__`` and
    ``__cached__``): `__import__` is called, not imported, and the
    program execs into `globals()`, which is `__main__`'s own dict, so it
    runs in the module identity CPython would have given it.

    Deliberate divergence: the preamble is itself a frame, so a
    traceback carries one extra `File "<string>"` line above the
    program's own. The frame that names the error is correct, which is
    the one that matters; removing the outer frame would mean catching
    and re-raising every exception, which would bind names in the
    program's namespace and rewrite `__context__`.

    Args:
        args (RunArgs): the run. A ``prog`` of None or "-c" with no
            script file means a payload, which CPython already reports
            correctly and which passes through untouched.
        search_path (bool): put the script's directory first on
            ``sys.path`` in place of the working directory's ``''``, as
            CPython does unless ``-P`` or ``-I`` asked for a safe path.
            Only an engine that serves the mounts to the guest can mean
            it: a host process sees no directory a script came from.
    """
    prog = args.prog
    filename = main_filename(args)
    if (
        not args.script_cli
        and filename is None
        and prog in (None, PAYLOAD_ARGV0)
    ):
        return args.code
    input_source = (
        "None"
        if args.stdin is None
        else "__import__('sys').stdin.buffer.read()"
    )
    bindings = (
        (
            "argv = list(__import__('sys').argv)\n"
            f"stdin = {input_source}\n"
            "__import__('sys').stdin = __import__('io').TextIOWrapper("
            "__import__('io').BytesIO(stdin or b''), "
            "encoding=__import__('sys').stdin.encoding, "
            "errors=__import__('sys').stdin.errors)\n"
        )
        if args.script_cli
        else ""
    )
    run_file = (
        ""
        if filename is None
        else f"__file__ = {filename!r}\n__cached__ = None\n"
    )
    if search_path and args.script_path is not None:
        run_file += (
            "if not __import__('sys').flags.safe_path:\n"
            "    __import__('sys').path[0] = __import__('os').path"
            ".dirname(__import__('os').path.realpath(__file__))\n"
        )
    argv0 = prog if prog is not None else PAYLOAD_ARGV0
    name = filename or prog or "<string>"
    return (
        f"__import__('sys').argv[0] = {argv0!r}\n"
        f"{run_file}{bindings}"
        f"exec(compile({args.code!r}, {name!r}, 'exec'), globals())\n"
    )
