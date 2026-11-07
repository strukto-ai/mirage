from mirage.shell.signals import (
    signal_description,
    signal_name,
    signal_number,
    signal_report,
    signal_table,
)


def test_signal_name_follows_kill_l():
    assert signal_name(2) == "INT"
    assert signal_name(34) == "RTMIN"
    assert signal_name(35) == "RTMIN+1"
    assert signal_name(49) == "RTMIN+15"
    assert signal_name(50) == "RTMAX-14"
    assert signal_name(64) == "RTMAX"
    assert signal_name(32) is None
    assert signal_name(65) is None


def test_signal_number_reads_every_spelling_bash_takes():
    assert signal_number("sigint") == 2
    assert signal_number(" +9") == 9
    assert signal_number("EXIT") == 0
    assert signal_number("RTMIN+30") == 64
    assert signal_number("RTMAX-14") == 50
    assert signal_number("RTMAX-15") is None
    assert signal_number("65") is None
    assert signal_number("INTÄ") is None


def test_signal_description_names_what_a_report_line_says():
    assert signal_description(9) == "Killed"
    assert signal_description(15) == "Terminated"
    assert signal_description(34) == "Real-time signal 0"
    assert signal_description(13) == "Broken pipe"
    assert signal_description(17) is None


def test_signal_table_lists_five_to_a_line():
    lines = signal_table().split("\n")
    assert (
        lines[0]
        == " 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 4) SIGILL\t 5) SIGTRAP"
    )
    assert lines[1].startswith(" 6) SIGABRT\t")
    assert "32)" not in signal_table()


VOICE = "bash: line 1: "


def test_signal_report_names_the_last_process_a_signal_ended():
    assert signal_report(VOICE, [(9, 137, 9, "sleep 3")], True) == (
        "bash: line 1:     9 Killed                  sleep 3\n"
    )
    assert signal_report(VOICE, [(9, 0, None, "true")], True) == ""
    assert signal_report(VOICE, [(9, 130, 2, "sleep 3")], True) == ""
    assert signal_report(VOICE, [(9, 141, 13, "yes")], True) == ""


def test_signal_report_tells_of_term_only_in_the_foreground():
    assert signal_report(VOICE, [(9, 143, 15, "sleep 3")], True) == (
        "Terminated\n"
    )
    assert signal_report(VOICE, [(9, 143, 15, "sleep 3")], False) == ""
    assert signal_report(VOICE, [(9, 129, 1, "sleep 3")], False) == (
        "bash: line 1:     9 Hangup                  sleep 3\n"
    )


def test_signal_report_lists_a_pipeline_under_its_first_stage():
    assert signal_report(
        VOICE,
        [
            (11, 0, None, "true"),
            (12, 3, None, "exit 3"),
            (13, 137, 9, "sh"),
            (14, 137, 9, "sh"),
            (15, 141, 13, "yes"),
            (16, 129, 1, "sh"),
        ],
        True,
    ).split("\n") == [
        "bash: line 1:    11 Done                    true",
        "        12 Exit 3                  | exit 3",
        "        13 Killed                  | sh",
        "        14                       | sh",
        "        15 Broken pipe             | yes",
        "        16 Hangup                  | sh",
        "",
    ]
