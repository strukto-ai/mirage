from collections.abc import AsyncIterator, Callable

import pytest

from mirage.core.awk.errors import AwkIOError, AwkRuntimeError
from mirage.core.awk.interp import ExitProgram, Interpreter
from mirage.core.awk.parser import parse
from mirage.core.awk.types import CommandRun
from mirage.core.awk.value import text

DATA = ["alice 30 eng", "bob 25 ops", "carol 41 eng", "dave 19 ops"]


class FakeHost:
    """An in-memory world: files by name, commands by line, one stdin."""

    def __init__(
        self,
        files: dict[str, str] | None = None,
        commands: dict[str, Callable[[bytes | None], CommandRun]]
        | None = None,
        stdin: str = "",
    ) -> None:
        self.files = dict(files or {})
        self.commands = commands or {}
        self.stdin = [stdin.encode()] if stdin else []
        self.runs: list[tuple[str, bytes | None]] = []

    def open_input(self, name: str, index: int | None) -> AsyncIterator[bytes]:
        return self.stream(name)

    async def stream(self, name: str) -> AsyncIterator[bytes]:
        if name in ("-", "/dev/stdin"):
            while self.stdin:
                yield self.stdin.pop(0)
            return
        if name not in self.files:
            raise AwkIOError("No such file or directory")
        yield self.files[name].encode()

    async def write_file(self, name: str, body: str, append: bool) -> None:
        if name.startswith("/ro/"):
            raise AwkIOError("Read-only file system")
        self.files[name] = (self.files.get(name, "") if append else "") + body

    async def run(self, command: str, stdin: bytes | None) -> CommandRun:
        self.runs.append((command, stdin))
        return self.commands[command](stdin)


def echo(
    out: str, status: int = 0, err: str = ""
) -> Callable[[bytes | None], CommandRun]:
    return lambda stdin: CommandRun(out.encode(), err.encode(), status)


def cat(stdin: bytes | None) -> CommandRun:
    return CommandRun(stdin or b"", b"", 0)


async def execute(
    program: str,
    host: FakeHost,
    argv: tuple[str, ...] = (),
    fs: str | None = None,
    assignments: dict[str, str] | None = None,
) -> tuple[str, str]:
    interp = Interpreter(parse(program), host, argv, assignments)
    if fs is not None:
        interp.set_var("FS", text(fs))
    try:
        await interp.run_begin()
        if interp.has_main_rules():
            while (record := await interp.next_record()) is not None:
                await interp.run_record(record)
        await interp.run_end()
    except ExitProgram:
        pass
    await interp.finish()
    out, err = await interp.drain()
    return out.decode(), err.decode()


async def run(
    program: str,
    lines: list[str] | None = None,
    fs: str | None = None,
    assignments: dict[str, str] | None = None,
) -> str:
    stdin = "".join(f"{line}\n" for line in lines or [])
    out, _ = await execute(program, FakeHost(stdin=stdin), (), fs, assignments)
    return out


@pytest.mark.asyncio
async def test_for_loop_builds_an_indent():
    program = (
        '{indent="";for(i=1;i<NF;i++)indent=indent"    ";print indent $NF}'
    )
    assert (
        await run(
            program, ["School/Courses_Materials/notes.md", "top.txt"], fs="/"
        )
        == "        notes.md\ntop.txt\n"
    )


@pytest.mark.asyncio
async def test_paragraph_mode_splits_fields_at_newlines_too():
    record = ["a:b\nc"]
    assert await run("{print NF}", record, ":", {"RS": ""}) == "3\n"
    assert await run("{print NF}", record, ":") == "2\n1\n"
    assert (
        await run('{RS=""; print NF}', ["a:b\nc\n", "d:e\nf"], ":")
        == "2\n1\n3\n"
    )


@pytest.mark.parametrize(
    "program,expected",
    [
        ("{s+=$2} END{print s, s/NR}", "115 28.75\n"),
        ("$2 > 26 {print $1}", "alice\ncarol\n"),
        ("NR==2,NR==3 {print $1}", "bob\ncarol\n"),
        ("!seen[$3]++", "alice 30 eng\nbob 25 ops\n"),
        ('$3=="ops"{next} {print $1}', "alice\ncarol\n"),
        ("NR==1||$2>max{max=$2; who=$1} END{print who, max}", "carol 41\n"),
        ('{c[$3]++} END{print c["eng"], c["ops"], length(c)}', "2 2 2\n"),
        ("END{print NR, $0}", "4 dave 19 ops\n"),
    ],
)
@pytest.mark.asyncio
async def test_records(program, expected):
    assert await run(program, DATA) == expected


@pytest.mark.parametrize(
    "program,expected",
    [
        (
            "BEGIN{print 7/2, 7%3, 2^10, -2^2, 0.1+0.2, 1/3}",
            "3.5 1 1024 -4 0.3 0.333333\n",
        ),
        ("BEGIN{i=5; print i++, i, ++i, i--, --i}", "5 6 7 7 5\n"),
        ('BEGIN{x=1; y=2; print x y, x+y, x" "y}', "12 3 1 2\n"),
        ('BEGIN{print x+0, "[" x "]", (x==0), (x=="")}', "0 [] 1 1\n"),
        ('BEGIN{print ("10"<"9"), (10<9), ("abc"<1)}', "1 0 0\n"),
        (
            "BEGIN{while(i<5){i++; if(i==2)continue; if(i==4)break; print i}}",
            "1\n3\n",
        ),
        ("BEGIN{do{print i++}while(i<3)}", "0\n1\n2\n"),
        ("BEGIN{for(;;){if(++n>3)break}; print n}", "4\n"),
        (
            "BEGIN{a[1,2]=3; for(k in a){split(k,p,SUBSEP); print p[1],p[2]}}",
            "1 2\n",
        ),
        ('BEGIN{a["x"]; delete a["x"]; print ("x" in a), length(a)}', "0 0\n"),
        (
            'BEGIN{n=split("c a b",q); for(i=1;i<=n;i++)printf "%s.",q[i]}',
            "c.a.b.",
        ),
        (
            "function fact(n){return n<=1?1:n*fact(n-1)} BEGIN{print fact(10)}",
            "3628800\n",
        ),
        (
            "function fill(arr,n,  i){for(i=1;i<=n;i++)arr[i]=i*i} "
            "BEGIN{fill(sq,3); print sq[3], length(sq)}",
            "9 3\n",
        ),
        ("function f(x){x=5} BEGIN{y=1; f(y); print y}", "1\n"),
        ('BEGIN{OFMT="%.2f"; x=3.14159; print x, x""}', "3.14 3.14159\n"),
        (
            'BEGIN{print length("héllo"), toupper("abc"), '
            'index("hello","ll")}',
            "6 ABC 3\n",
        ),
        ('BEGIN{print match("foobar",/o+/), RSTART, RLENGTH}', "2 2 2\n"),
        (
            "BEGIN{srand(1); a=rand(); srand(1); print (a==rand()), (a<1)}",
            "1 1\n",
        ),
        ('BEGIN{a[10]; a[9]; a["x"]; for(k in a)printf "%s ", k}', "10 9 x "),
    ],
)
@pytest.mark.asyncio
async def test_begin_programs(program, expected):
    assert await run(program) == expected


@pytest.mark.asyncio
async def test_begin_float_assignment():
    # Issue #1156: the scraper this interpreter replaced refused an
    # assignment in BEGIN as an unsupported construct.
    assert await run("BEGIN {a=7*7.172100067138672; print a}") == "50.2047\n"


@pytest.mark.asyncio
async def test_field_assignment_rebuilds_the_record():
    assert await run('{$2="X"; print; print NF}', ["a b c"]) == "a X c\n3\n"
    assert await run("{NF=2; print}", ["a b c"]) == "a b\n"
    assert await run('{$5="e"; print; print NF}', ["a b"]) == "a b   e\n5\n"
    assert await run('BEGIN{OFS="-"} {$1=$1; print}', ["a b c"]) == "a-b-c\n"


@pytest.mark.asyncio
async def test_fs_assigned_in_an_action_applies_from_the_next_record():
    assert await run('{FS=":"; print $1}', ["a:b c", "d:e f"]) == "a:b\nd\n"


@pytest.mark.asyncio
async def test_strnum_fields_compare_numerically():
    assert (
        await run('{print ($1==10), ($1=="10"), ($3==0)}', ["10.0 x"])
        == "1 0 0\n"
    )


@pytest.mark.asyncio
async def test_command_line_assignment_is_a_strnum():
    assert (
        await run("BEGIN{print n+1, (n==5)}", assignments={"n": "5"})
        == "6 1\n"
    )


@pytest.mark.asyncio
async def test_environ_holds_the_environment_as_strnums():
    interp = Interpreter(
        parse(
            'BEGIN{print ENVIRON["n"]+1, (ENVIRON["n"]==5), ("m" in ENVIRON)}'
        ),
        FakeHost(),
        environ={"n": "05"},
    )
    await interp.run_begin()
    assert (await interp.drain())[0] == b"6 1 0\n"


@pytest.mark.asyncio
async def test_exit_carries_its_code_and_end_still_runs():
    interp = Interpreter(
        parse('NR==2{exit 3} {print} END{print "end"}'),
        FakeHost(stdin="a\nb\nc\n"),
    )
    await interp.run_record(await interp.next_record() or "")
    with pytest.raises(ExitProgram) as stop:
        await interp.run_record(await interp.next_record() or "")
    assert stop.value.code == 3
    await interp.run_end()
    assert (await interp.drain())[0] == b"a\nend\n"


@pytest.mark.asyncio
async def test_nextfile_moves_to_the_next_operand():
    host = FakeHost({"a.txt": "one\ntwo\n", "b.txt": "three\n"})
    out, _ = await execute(
        "{print FILENAME, $0; nextfile}", host, ("a.txt", "b.txt")
    )
    assert out == "a.txt one\nb.txt three\n"


@pytest.mark.asyncio
async def test_filename_and_fnr_restart_per_file():
    host = FakeHost({"a.txt": "x\n", "b.txt": "y\n"})
    out, _ = await execute(
        "{print FILENAME, NR, FNR}", host, ("a.txt", "b.txt")
    )
    assert out == "a.txt 1 1\nb.txt 2 1\n"


@pytest.mark.asyncio
async def test_stdin_is_named_dash():
    out, _ = await execute(
        'BEGIN{printf "[%s]", FILENAME} {print FILENAME}',
        FakeHost(stdin="s\n"),
    )
    assert out == "[]-\n"


@pytest.mark.asyncio
async def test_dev_stderr_is_kept_apart():
    out, err = await execute(
        '{print "w" > "/dev/stderr"; print}', FakeHost(stdin="a\n")
    )
    assert (out, err) == ("a\n", "w\n")


@pytest.mark.parametrize(
    "program,expected",
    [
        ("NR==1{getline; print}", "b\n"),
        ("{print} NR==2{getline x}", "a\nb\n"),
        ("NR==1{getline v; print v, NR, FNR, NF, $0}", "b 2 2 1 a\n"),
        ("{r=getline; print r, $0, NR}", "1 b 2\n0 c 3\n"),
        ("END{r=getline; print r, $0, NR}", "0 c 3\n"),
        (
            'BEGIN{getline; print "B", $0, NR} {print "M", $0, NR}',
            "B a 1\nM b 2\nM c 3\n",
        ),
        (
            "NR==1{while ((getline l) > 0) last=l} END{print last, NR, $0}",
            "c 3 a\n",
        ),
        ("{ print (getline) (getline) }", "11\n"),
    ],
)
@pytest.mark.asyncio
async def test_plain_getline_reads_the_main_input(program, expected):
    assert await run(program, ["a", "b", "c"]) == expected


@pytest.mark.asyncio
async def test_plain_getline_crosses_operands_and_assignments():
    host = FakeHost({"f1": "1\n", "f2": "2\n3\n"})
    out, _ = await execute(
        '{print "rec", $0; while ((getline l) > 0) '
        'print "got", l, x, FILENAME, FNR, NR}',
        host,
        ("f1", "x=5", "f2"),
    )
    assert out == "rec 1\ngot 2 5 f2 1 2\ngot 3 5 f2 2 3\n"


@pytest.mark.parametrize(
    "argv,program,expected",
    [
        (("x=1", "f1", "x=2", "f2"), "{print x}", "1\n2\n2\n"),
        (("f1", "x=7"), "END{print x}", "7\n"),
        (("x=a\\tb", "f1"), "{print x}", "a\tb\n"),
        (("x=010", "f1"), "{print x+0, (x < 9)}", "10 0\n"),
        (
            ("f1", "x=1"),
            "BEGIN{for(i=0;i<ARGC;i++) print i, ARGV[i]}",
            "0 awk\n1 f1\n2 x=1\n",
        ),
        (("f1", "f2"), 'BEGIN{ARGV[1]=""} {print}', "2\n3\n"),
        (("f1",), 'BEGIN{ARGV[1]="f2"} {print FILENAME, $0}', "f2 2\nf2 3\n"),
        (("f1",), 'BEGIN{ARGV[ARGC++]="f2"} {print}', "1\n2\n3\n"),
        (("f1", "f2"), "BEGIN{ARGC=2} {print}", "1\n"),
        (("f1", "f2"), "BEGIN{delete ARGV[1]} {print}", "2\n3\n"),
        (("f1", "f2"), 'BEGIN{ARGV[1]="x=9"} {print x, $0}', "9 2\n9 3\n"),
        (("f1", "", "f2"), "{print}", "1\n2\n3\n"),
        (("1x=3",), "{print}", ""),
    ],
)
@pytest.mark.asyncio
async def test_operands_follow_argv(argv, program, expected):
    host = FakeHost({"f1": "1\n", "f2": "2\n3\n", "1x=3": ""})
    out, _ = await execute(program, host, argv)
    assert out == expected


@pytest.mark.asyncio
async def test_only_assignments_read_stdin_after_them():
    out, _ = await execute(
        "{print x, $0, FILENAME}", FakeHost(stdin="s\n"), ("x=1",)
    )
    assert out == "1 s -\n"


@pytest.mark.asyncio
async def test_an_operand_that_cannot_be_opened_is_fatal():
    with pytest.raises(AwkRuntimeError) as raised:
        await execute(
            "{getline; print}", FakeHost({"f1": "1\n"}), ("f1", "nope")
        )
    assert str(raised.value) == (
        'awk: cannot open "nope" (No such file or directory)'
    )


GETLINE_FILES = {
    "g": "a\nb\n",
    "p": "a\nb\n\nc\n",
    "r": "a1b2c",
    "c": "x:y:z\n",
    "n": "10\n",
}


@pytest.mark.parametrize(
    "program,expected",
    [
        ('BEGIN{while ((getline line < "g") > 0) print line}', "a\nb\n"),
        ('BEGIN{while (getline line < "g" > 0) print line}', "a\nb\n"),
        ('BEGIN{while (getline < "g" > 0) print $0}', "a\nb\n"),
        ('BEGIN{r = (getline line < "nope"); print r}', "-1\n"),
        ('BEGIN{getline < "g"; print $0, NF, NR, FNR}', "a 1 0 0\n"),
        (
            'BEGIN{getline a < "g"; close("g"); getline b < "g"; print a, b}',
            "a a\n",
        ),
        (
            'BEGIN{getline a < "g"; getline b < "g"; r = getline c < "g"; '
            'print a, b, r, "[" c "]"}',
            "a b 0 []\n",
        ),
        (
            'BEGIN{getline a < "g"; print close("g"), close("g"), close("x")}',
            "0 -1 -1\n",
        ),
        ('BEGIN{r = getline x < "/" "g"; print r, "[" x "]"}', "-1g []\n"),
        (
            'BEGIN{RS=""; while ((getline l < "p")>0) print "[" l "]"}',
            "[a\nb]\n[c]\n",
        ),
        (
            'BEGIN{RS="[0-9]"; while ((getline l < "r")>0) print l}',
            "a\nb\nc\n",
        ),
        ('BEGIN{FS=":"; getline < "c"; print $2, NF}', "y 3\n"),
        (
            'BEGIN{r = getline v < "nope"; print r, length(v), (v == 0), '
            '(v == "")}',
            "-1 0 1 1\n",
        ),
        ('BEGIN{x = "A"; getline x < "nope"; print x}', "A\n"),
        ('BEGIN{getline v < "n"; print (v < 9)}', "0\n"),
        ('BEGIN{f="g"; print getline x < f + 1; print x}', "2\na\n"),
        ('BEGIN{n=1; f[1]="g"; getline x < f[n++]; print x, n}', "a 2\n"),
        ('BEGIN{getline a["k"] < "g"; print a["k"]}', "a\n"),
        ('BEGIN{ x = getline y < "g" == 1; print x, y }', "1 a\n"),
        ('BEGIN{ print getline < "g" < "g" }', "1\n"),
        (
            'function f(  l){ getline l < "g"; return l } BEGIN{print f()}',
            "a\n",
        ),
        (
            'BEGIN{print "x" > "o"; close("o"); getline l < "o"; print "l=" l}',
            "l=x\n",
        ),
        ('BEGIN{print "x" > "o"; getline l < "o"; print "l=" l}', "l=\n"),
    ],
)
@pytest.mark.asyncio
async def test_getline_from_a_file(program, expected):
    out, _ = await execute(program, FakeHost(GETLINE_FILES))
    assert out == expected


@pytest.mark.asyncio
async def test_getline_dash_shares_stdin_with_the_main_input():
    out, _ = await execute(
        'NR==1{r = getline a < "-"; print "a=" a, r} {print}',
        FakeHost(stdin="p\nq\n"),
    )
    assert out == "a= 0\np\nq\n"


@pytest.mark.parametrize(
    "program,expected",
    [
        ('BEGIN{"echo hi" | getline x; print x}', "hi\n"),
        (
            'BEGIN{while ("echo hi" | getline > 0) print "l", $0, NR, NF}',
            "l hi 0 1\n",
        ),
        (
            'BEGIN{"echo hi" | getline a; r = ("echo hi" | getline b); '
            'print a, r, "[" b "]", close("echo hi"), close("echo hi")}',
            "hi 0 [] 0 -1\n",
        ),
        (
            'BEGIN{"echo hi" | getline a; close("echo hi"); "echo hi" | getline b; '
            "print a b}",
            "hihi\n",
        ),
        ('BEGIN{"fail" | getline; print close("fail")}', "2\n"),
        ('BEGIN{x = 1 + "echo hi" | getline; print x, $0}', "2 hi\n"),
        ('BEGIN{x = "a" "echo hi" | getline; print x}', "a1\n"),
        ('BEGIN{x = "echo hi" | getline + 1; print x}', "2\n"),
        ('BEGIN{x = -"echo hi" | getline; print x}', "-1\n"),
        ('BEGIN{x = "echo hi" | getline a "b"; print x, a}', "1b hi\n"),
        ('BEGIN{"echo hi" | getline $2; print $0; print NF}', " hi\n2\n"),
    ],
)
@pytest.mark.asyncio
async def test_getline_from_a_command(program, expected):
    host = FakeHost(commands={"echo hi": echo("hi\n"), "fail": echo("", 2)})
    out, _ = await execute(program, host)
    assert out == expected


@pytest.mark.asyncio
async def test_a_command_reads_awk_stdin_when_it_runs():
    host = FakeHost(commands={"cat": cat})
    await execute('BEGIN{"cat" | getline x; system("cat")}', host)
    assert host.runs == [("cat", None), ("cat", None)]


@pytest.mark.parametrize(
    "program,expected",
    [
        (
            'BEGIN{print "b" | "sort"; print "a" | "sort"; print "x"}',
            "[b\na\n]\nx\n",
        ),
        (
            'BEGIN{print "0"; print "1" | "cat"; close("cat"); print "2"}',
            "0\n1\n2\n",
        ),
        (
            'BEGIN{print "1" | "cat"; print "0"; close("cat"); print "2"}',
            "1\n0\n2\n",
        ),
        ('BEGIN{print "1" | "cat"; print "0"; system("")}', "0\n1\n"),
        ('BEGIN{print "1" | "cat"; print "0"; fflush()}', "0\n1\n"),
        ('BEGIN{print "1" | "cat"; print "0"; "echo hi" | getline}', "0\n1\n"),
        ('BEGIN{print "1" | "cat"; print "0"; exit}', "1\n0\n"),
        ('BEGIN{print "c" | "cat"; print "s" | "sort"}', "[s\n]\nc\n"),
        (
            'BEGIN{print "x" | "cat"; r = close("cat"); print r, close("cat")}',
            "x\n0 -1\n",
        ),
        ('BEGIN{printf "%s", "z" | "cat"; close("cat"); print ""}', "z\n"),
        (
            'BEGIN{print "to" | "cat"; system("echo hi"); print "end"}',
            "hi\nto\nend\n",
        ),
        ('BEGIN{print "a"; r = system("fail"); print "c", r}', "a\nc 2\n"),
    ],
)
@pytest.mark.asyncio
async def test_output_pipes_and_system_order_like_mawk(program, expected):
    host = FakeHost(
        commands={
            "cat": cat,
            "sort": lambda stdin: CommandRun(
                b"[" + (stdin or b"") + b"]\n", b"", 0
            ),
            "echo hi": echo("hi\n"),
            "fail": echo("", 2, "oops\n"),
            "": echo(""),
        }
    )
    out, _ = await execute(program, host)
    assert out == expected


@pytest.mark.asyncio
async def test_command_stderr_joins_awk_stderr():
    host = FakeHost(commands={"fail": echo("", 2, "oops\n")})
    out, err = await execute('BEGIN{system("fail"); print "o"}', host)
    assert (out, err) == ("o\n", "oops\n")


@pytest.mark.asyncio
async def test_a_command_sees_files_written_before_it_runs():
    host = FakeHost(commands={"check": lambda _: CommandRun(b"", b"", 0)})
    interp = Interpreter(
        parse('BEGIN{printf "x" > "f"; system("check")}'), host
    )
    await interp.run_begin()
    assert host.files["f"] == "x"


@pytest.mark.asyncio
async def test_output_file_is_emptied_when_opened_and_filled_on_flush():
    host = FakeHost({"f": "old"})
    interp = Interpreter(
        parse('BEGIN{print "a" > "f"; print "b" > "f"}'), host
    )
    await interp.run_begin()
    assert host.files["f"] == ""
    await interp.drain()
    assert host.files["f"] == "a\nb\n"


@pytest.mark.asyncio
async def test_fflush_answers_per_stream():
    out, _ = await execute(
        'BEGIN{printf "x" > "q"; print fflush("q"), fflush("nope"), '
        'fflush(), fflush("")}',
        FakeHost(),
    )
    assert out == "0 -1 0 0\n"


@pytest.mark.asyncio
async def test_output_failure_is_fatal_and_keeps_earlier_output():
    interp = Interpreter(
        parse('BEGIN{print "a"; print "b" > "/ro/x"}'), FakeHost()
    )
    with pytest.raises(AwkRuntimeError) as raised:
        await interp.run_begin()
    assert await interp.salvage(raised.value) == (
        b"a\n",
        b'awk: cannot open "/ro/x" for output (Read-only file system)\n',
    )


@pytest.mark.parametrize(
    "program,message",
    [
        ("BEGIN{print 1/0}", "awk: division by zero"),
        ("BEGIN{print 5%0}", "awk: division by zero in %"),
        ("BEGIN{x=1; x/=0}", "awk: division by zero in /="),
        ("BEGIN{x=1; x%=0}", "awk: division by zero in %="),
        ("BEGIN{print $(-1)}", "awk: trying to access field -1"),
        ("BEGIN{f(1)}", "awk: calling undefined function f"),
        ("BEGIN{next}", "awk: next used in a BEGIN action"),
        ('BEGIN{substr("a")}', "awk: not enough arguments to substr"),
        (
            "function f(n){return f(n+1)} BEGIN{f(1)}",
            "awk: function f nested deeper than 100 calls",
        ),
    ],
)
@pytest.mark.asyncio
async def test_runtime_errors(program, message):
    with pytest.raises(AwkRuntimeError) as raised:
        await run(program)
    assert str(raised.value) == message
