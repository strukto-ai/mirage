from mirage.workspace.executor.builtins.getopt import last_of, scan_options


def test_letters_keep_typed_order_with_repeats():
    scan = scan_options(["-a", "-tp", "-t", "cd"], "afptP")
    assert scan.letters == ("a", "t", "p", "t")
    assert scan.operands == ("cd", )
    assert scan.bad is None


def test_scan_is_non_permuting():
    scan = scan_options(["-a", "cd", "-t"], "at")
    assert scan.letters == ("a", )
    assert scan.operands == ("cd", "-t")


def test_double_dash_ends_options():
    scan = scan_options(["-a", "--", "-t"], "at")
    assert scan.letters == ("a", )
    assert scan.operands == ("-t", )


def test_bare_dash_is_an_operand():
    scan = scan_options(["-"], "at")
    assert scan.letters == ()
    assert scan.operands == ("-", )


def test_unknown_letter_is_reported_as_bash_spells_it():
    assert scan_options(["-x", "cd"], "at").bad == "-x"


def test_a_long_spelling_fails_on_its_second_dash():
    # bash: `type --foo` refuses `--`, not `--foo`.
    assert scan_options(["--foo", "cd"], "afptP").bad == "--"


def test_no_args_scans_to_nothing():
    scan = scan_options([], "at")
    assert scan.letters == ()
    assert scan.operands == ()
    assert scan.bad is None


def test_last_of_resolves_a_mutually_exclusive_group():
    assert last_of(("t", "p"), "tpP") == "p"
    assert last_of(("p", "t"), "tpP") == "t"
    assert last_of(("t", "p", "t"), "tpP") == "t"
    assert last_of(("a", ), "tpP") is None
    assert last_of((), "vV") is None
