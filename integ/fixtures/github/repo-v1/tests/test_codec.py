from src.codec.step_1 import codec_step_1


def test_codec_step_1() -> None:
    assert codec_step_1(1) == 2
