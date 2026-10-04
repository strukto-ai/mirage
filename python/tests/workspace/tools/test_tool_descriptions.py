from mirage.workspace.tools import tool_descriptions as shared

TOOLS = ["SHELL", "READ", "WRITE", "EDIT", "LS", "GREP", "GLOB"]


def test_every_tool_has_a_description_and_an_input_schema():
    names = [f"{t}_DESCRIPTION" for t in TOOLS] + [f"{t}_INPUT" for t in TOOLS]
    assert sorted(shared.__all__) == sorted(names)
    for tool in TOOLS:
        assert getattr(shared, f"{tool}_DESCRIPTION").strip()
        schema = getattr(shared, f"{tool}_INPUT")
        assert schema["type"] == "object"
        assert set(schema["required"]) <= set(schema["properties"])
        for prop in schema["properties"].values():
            assert prop["description"]


def test_edit_description_documents_the_stale_check():
    # The tools refuse an edit to a file that moved since it was read, so
    # the description has to say so or the agent cannot tell that failure
    # from a bad old_string.
    assert "changed since it was last read" in shared.EDIT_DESCRIPTION
    assert "replace_all=true" in shared.EDIT_DESCRIPTION
