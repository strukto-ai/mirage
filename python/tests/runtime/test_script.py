import pytest

from mirage.runtime.language import LanguageRuntime
from mirage.runtime.script import script_engine
from mirage.runtime.types import ScriptSource


def test_script_engine_builds_the_named_runtime():
    engine = script_engine(ScriptSource("..."), "monty")
    assert engine.name == "monty"
    assert isinstance(engine, LanguageRuntime)


# The wrong language is answered from the table before building, so a
# config naming the wrong runtime reads as that, not as its install
# hint.
@pytest.mark.parametrize(
    ("runtime", "refusal"),
    [
        ("sandlock", "runs no programs"),
        ("workspace", "runs no programs"),
        ("nope", "unknown runtime"),
        ("quickjs", "python, but names runtime"),
    ],
)
def test_script_engine_refuses_a_runtime_it_cannot_use(runtime, refusal):
    with pytest.raises(ValueError, match=refusal):
        script_engine(ScriptSource("..."), runtime)


def test_script_engine_passes_the_settings_and_names_a_missing_build(
    monkeypatch,
):
    monkeypatch.delenv("MIRAGE_WASI_HOME", raising=False)
    with pytest.raises(ValueError, match="names runtime 'wasi': .*WASI build"):
        script_engine(ScriptSource("..."), "wasi")
    with pytest.raises(ValueError, match="no python.wasm under /nowhere"):
        script_engine(ScriptSource("..."), "wasi", {"home": "/nowhere"})
    with pytest.raises(ValueError, match="names runtime 'monty'"):
        script_engine(ScriptSource("..."), "monty", {"ghost": 1})
