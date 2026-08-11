from src.parse.step_1 import parse_step_1


def test_parse_step_1() -> None:
    assert parse_step_1(1) == 2
