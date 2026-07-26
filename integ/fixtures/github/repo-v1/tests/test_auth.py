from src.auth.step_1 import auth_step_1


def test_auth_step_1() -> None:
    assert auth_step_1(1) == 2
