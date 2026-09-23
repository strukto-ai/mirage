import pytest

from mirage.core.awk.errors import AwkRuntimeError
from mirage.core.awk.interp import ExitProgram, Interpreter
from mirage.core.awk.parser import parse
from mirage.core.awk.value import text

DATA = ["alice 30 eng", "bob 25 ops", "carol 41 eng", "dave 19 ops"]


def run(program: str,
        lines: list[str] | None = None,
        fs: str | None = None,
        assignments: dict[str, str] | None = None) -> str:
    interp = Interpreter(parse(program), assignments)
    if fs is not None:
        interp.set_var("FS", text(fs))
    interp.run_begin()
    for line in lines or []:
        interp.run_record(line)
    interp.run_end()
    return interp.drain()


def test_for_loop_builds_an_indent():
    program = ('{indent="";for(i=1;i<NF;i++)indent=indent"    ";'
               'print indent $NF}')
    assert run(program, ["School/Courses_Materials/notes.md", "top.txt"],
               fs="/") == "        notes.md\ntop.txt\n"


def test_paragraph_mode_splits_fields_at_newlines_too():
    record = ["a:b\nc"]
    assert run("{print NF}", record, ":", {"RS": ""}) == "3\n"
    assert run("{print NF}", record, ":") == "2\n"
    assert run('{RS=""; print NF}', ["a:b\nc", "d:e\nf"], ":") == "2\n3\n"


@pytest.mark.parametrize("program,expected", [
    ("{s+=$2} END{print s, s/NR}", "115 28.75\n"),
    ("$2 > 26 {print $1}", "alice\ncarol\n"),
    ("NR==2,NR==3 {print $1}", "bob\ncarol\n"),
    ("!seen[$3]++", "alice 30 eng\nbob 25 ops\n"),
    ("$3==\"ops\"{next} {print $1}", "alice\ncarol\n"),
    ("NR==1||$2>max{max=$2; who=$1} END{print who, max}", "carol 41\n"),
    ("{c[$3]++} END{print c[\"eng\"], c[\"ops\"], length(c)}", "2 2 2\n"),
    ("END{print NR, $0}", "4 dave 19 ops\n"),
])
def test_records(program, expected):
    assert run(program, DATA) == expected


@pytest.mark.parametrize("program,expected", [
    ("BEGIN{print 7/2, 7%3, 2^10, -2^2, 0.1+0.2, 1/3}",
     "3.5 1 1024 -4 0.3 0.333333\n"),
    ("BEGIN{i=5; print i++, i, ++i, i--, --i}", "5 6 7 7 5\n"),
    ("BEGIN{x=1; y=2; print x y, x+y, x\" \"y}", "12 3 1 2\n"),
    ("BEGIN{print x+0, \"[\" x \"]\", (x==0), (x==\"\")}", "0 [] 1 1\n"),
    ("BEGIN{print (\"10\"<\"9\"), (10<9), (\"abc\"<1)}", "1 0 0\n"),
    ("BEGIN{while(i<5){i++; if(i==2)continue; if(i==4)break; print i}}",
     "1\n3\n"),
    ("BEGIN{do{print i++}while(i<3)}", "0\n1\n2\n"),
    ("BEGIN{for(;;){if(++n>3)break}; print n}", "4\n"),
    ("BEGIN{a[1,2]=3; for(k in a){split(k,p,SUBSEP); print p[1],p[2]}}",
     "1 2\n"),
    ("BEGIN{a[\"x\"]; delete a[\"x\"]; print (\"x\" in a), length(a)}",
     "0 0\n"),
    ("BEGIN{n=split(\"c a b\",q); for(i=1;i<=n;i++)printf \"%s.\",q[i]}",
     "c.a.b."),
    ("function fact(n){return n<=1?1:n*fact(n-1)} BEGIN{print fact(10)}",
     "3628800\n"),
    ("function fill(arr,n,  i){for(i=1;i<=n;i++)arr[i]=i*i} "
     "BEGIN{fill(sq,3); print sq[3], length(sq)}", "9 3\n"),
    ("function f(x){x=5} BEGIN{y=1; f(y); print y}", "1\n"),
    ("BEGIN{OFMT=\"%.2f\"; x=3.14159; print x, x\"\"}", "3.14 3.14159\n"),
    ("BEGIN{print length(\"héllo\"), toupper(\"abc\"), "
     "index(\"hello\",\"ll\")}", "5 ABC 3\n"),
    ("BEGIN{print match(\"foobar\",/o+/), RSTART, RLENGTH}", "2 2 2\n"),
    ("BEGIN{srand(1); a=rand(); srand(1); print (a==rand()), (a<1)}", "1 1\n"),
    ("BEGIN{a[10]; a[9]; a[\"x\"]; for(k in a)printf \"%s \", k}", "10 9 x "),
])
def test_begin_programs(program, expected):
    assert run(program) == expected


def test_begin_float_assignment():
    # Issue #1156: the scraper this interpreter replaced refused an
    # assignment in BEGIN as an unsupported construct.
    assert run("BEGIN {a=7*7.172100067138672; print a}") == "50.2047\n"


def test_field_assignment_rebuilds_the_record():
    assert run("{$2=\"X\"; print; print NF}", ["a b c"]) == "a X c\n3\n"
    assert run("{NF=2; print}", ["a b c"]) == "a b\n"
    assert run("{$5=\"e\"; print; print NF}", ["a b"]) == "a b   e\n5\n"
    assert run("BEGIN{OFS=\"-\"} {$1=$1; print}", ["a b c"]) == "a-b-c\n"


def test_fs_assigned_in_an_action_applies_from_the_next_record():
    assert run("{FS=\":\"; print $1}", ["a:b c", "d:e f"]) == "a:b\nd\n"


def test_strnum_fields_compare_numerically():
    assert run("{print ($1==10), ($1==\"10\"), ($3==0)}",
               ["10.0 x"]) == "1 0 0\n"


def test_command_line_assignment_is_a_strnum():
    assert run("BEGIN{print n+1, (n==5)}", assignments={"n": "5"}) == "6 1\n"


def test_exit_carries_its_code_and_end_still_runs():
    interp = Interpreter(parse("NR==2{exit 3} {print} END{print \"end\"}"))
    interp.run_record("a")
    with pytest.raises(ExitProgram) as stop:
        interp.run_record("b")
    assert stop.value.code == 3
    interp.run_end()
    assert interp.drain() == "a\nend\n"


def test_nextfile_flags_the_driver():
    interp = Interpreter(parse("{print; nextfile}"))
    interp.start_file("a.txt")
    interp.run_record("one")
    assert interp.skip_file is True
    interp.start_file("b.txt")
    assert interp.skip_file is False


def test_filename_and_fnr_restart_per_file():
    interp = Interpreter(parse("{print FILENAME, NR, FNR}"))
    interp.start_file("a.txt")
    interp.run_record("x")
    interp.start_file("b.txt")
    interp.run_record("y")
    assert interp.drain() == "a.txt 1 1\nb.txt 2 1\n"


def test_dev_stderr_is_kept_apart():
    interp = Interpreter(parse('{print "w" > "/dev/stderr"; print}'))
    interp.run_record("a")
    assert interp.drain() == "a\n"
    assert interp.drain_err() == "w\n"


@pytest.mark.parametrize("program,message", [
    ("BEGIN{print 1/0}", "awk: division by zero"),
    ("BEGIN{print 5%0}", "awk: division by zero in %"),
    ("BEGIN{x=1; x/=0}", "awk: division by zero in /="),
    ("BEGIN{x=1; x%=0}", "awk: division by zero in %="),
    ("BEGIN{print $(-1)}", "awk: trying to access field -1"),
    ("BEGIN{getline x}", "awk: getline is not supported in mirage"),
    ("BEGIN{\"date\" | getline x}", "awk: getline is not supported in mirage"),
    ("BEGIN{print 1 | \"sort\"}",
     "awk: output pipes are not supported in mirage"),
    ("BEGIN{system(\"ls\")}", "awk: system() is not supported in mirage"),
    ("BEGIN{f(1)}", "awk: calling undefined function f"),
    ("BEGIN{next}", "awk: next used in a BEGIN action"),
    ("BEGIN{substr(\"a\")}", "awk: not enough arguments to substr"),
    ("function f(n){return f(n+1)} BEGIN{f(1)}",
     "awk: function f nested deeper than 100 calls"),
])
def test_runtime_errors(program, message):
    with pytest.raises(AwkRuntimeError) as raised:
        run(program)
    assert str(raised.value) == message
