from mirage.commands.builtin.grep_scan import exit_code_for


def test_exit_code_for_a_match_is_zero():
    assert exit_code_for(True, False, False) == 0


def test_exit_code_for_no_match_is_one():
    assert exit_code_for(False, False, False) == 1


def test_exit_code_for_an_unread_operand_outranks_a_match():
    assert exit_code_for(True, True, False) == 2
    assert exit_code_for(False, True, False) == 2


def test_exit_code_for_quiet_answers_a_match_despite_an_error():
    assert exit_code_for(True, True, True) == 0
    assert exit_code_for(False, True, True) == 2
