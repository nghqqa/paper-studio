"""Guard the packaged assets against accidentally vendoring download errors."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "app" / "latex_seed"


def test_latex_template_dependencies_are_real_files():
    for path in ROOT.rglob("*"):
        if path.suffix in (".cls", ".sty", ".bst"):
            text = path.read_text(encoding="utf-8")
            assert len(text) > 100, f"Truncated template dependency: {path}"
            assert not text.lstrip().startswith(("404:", "Bad Gateway", "<!DOCTYPE html", "<html")), path


def test_official_samples_have_matching_entrypoints_and_dependencies():
    for name, entry, dependency in [
        ("acl_style", "acl_latex.tex", "custom.bib"),
        ("iclr2027", "iclr2027_conference.tex", "math_commands.tex"),
    ]:
        root = ROOT / name
        meta = json.loads((root / "template.json").read_text(encoding="utf-8"))
        assert meta["main"] == entry
        assert (root / dependency).is_file()
        source = (root / entry).read_text(encoding="utf-8")
        assert len(source) > 10000  # Full upstream instructions, not the former short skeleton.
        assert "\\bibliography{" in source
