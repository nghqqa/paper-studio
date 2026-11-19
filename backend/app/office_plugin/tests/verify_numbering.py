"""Exercise production formula commands with a real Docs 10.0 Document Builder.

Usage: python backend/app/office_plugin/tests/verify_numbering.py --container NAME
Only generated scratch documents are used. Requires Docker and Python's stdlib.
An optional --fonts-dir is a path inside the container to licensed test fonts.
PDFs are retained for visual inspection; this does not test desktop Word/WPS.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import uuid
import xml.etree.ElementTree as ET
from zipfile import ZipFile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main", "m": "http://schemas.openxmlformats.org/officeDocument/2006/math"}
W = "{" + NS["w"] + "}"


def run(*args: str) -> str:
    result = subprocess.run(args, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
    return result.stdout


def inspect(path: Path, count: int, columns: bool = False) -> dict:
    with ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
        assert not any("vbaproject" in name.lower() for name in archive.namelist())
    assert not root.findall(".//w:tbl", NS), "numbering still contains a table"
    assert len(root.findall(".//m:oMath", NS)) == count
    if count != 1:
        assert len(root.findall(".//m:f", NS)) == 1
        assert len(root.findall(".//m:m/m:mr/m:e", NS)) == 4, "matrix structure changed"
        assert root.findall(".//m:sSup", NS), "superscript lost"
    else:
        assert any(mark.get(W + "name") == "eq_native" for mark in root.findall(".//w:bookmarkStart", NS)), "native numbering dropped bookmark"
    for tag in ("drawing", "object", "pict"):
        assert not root.findall(f".//w:{tag}", NS), "math became an image or OLE object"
    section = root.find(".//w:sectPr", NS)
    size, margin = section.find("w:pgSz", NS), section.find("w:pgMar", NS)
    width = int(size.get(W + "w")) - int(margin.get(W + "left")) - int(margin.get(W + "right"))
    if columns:
        cols = section.find("w:cols", NS)
        width = (width - int(cols.get(W + "space"))) / int(cols.get(W + "num"))
    positions, labels = [], []
    for p in root.findall(".//w:body/w:p", NS):
        if p.find("m:oMath", NS) is None:
            continue
        stops = p.findall("w:pPr/w:tabs/w:tab", NS)
        assert [t.get(W + "val") for t in stops] == ["center", "right"]
        pair = [int(t.get(W + "pos")) for t in stops]
        assert abs(pair[0] * 2 - width) <= 2 and abs(pair[1] - width) <= 1, pair
        is_long = count == 6 and len(positions) == 4
        assert len(p.findall("w:r/w:tab", NS)) == (3 if is_long else 2)
        if is_long:
            assert len(p.findall("w:r/w:br", NS)) == 1
        positions.append(pair)
        labels.append("".join(t.text or "" for t in p.findall("w:r/w:t", NS)))
    assert len(positions) == count
    expected = [f"({i})" for i in range(1, count + 1)]
    if count == 6:
        expected[-1] = "（6）"
    assert labels == expected
    if count == 6:
        assert "Body text after equations." in "".join(t.text or "" for t in root.findall(".//w:t", NS))
    return {"math": count, "tables": 0, "native_fraction": bool(root.findall(".//m:f", NS)), "matrix_cells": len(root.findall(".//m:m/m:mr/m:e", NS)), "labels": labels, "tabs_twips": positions}


def inspect_fonts(path: Path) -> dict:
    with ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    assert not root.findall(".//w:tbl", NS)
    maths = root.findall(".//m:oMath", NS)
    assert len(maths) == 3
    sizes = [32, 24, 21]
    for math, expected in zip(maths, sizes):
        values = [int(n.get(W + "val")) for n in math.findall(".//m:r/w:rPr/w:sz", NS)]
        assert values and set(values) == {expected}, (expected, values)
        fonts = [n.get(W + "ascii") for n in math.findall(".//m:r/w:rPr/w:rFonts", NS)]
        assert fonts and set(fonts) == {"Cambria Math"}, fonts
    labels = []
    for p in root.findall(".//w:body/w:p", NS):
        for run in p.findall("w:r", NS):
            if "".join(t.text or "" for t in run.findall("w:t", NS)) in ("(1)", "(2)"):
                labels.append(int(run.find("w:rPr/w:sz", NS).get(W + "val")))
    assert labels == sizes[:2]
    return {"math": 3, "tables": 0, "font_sizes_half_points": sizes, "label_sizes_half_points": labels, "math_font": "Cambria Math"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True)
    parser.add_argument("--fonts-dir")
    args = parser.parse_args()
    identity = uuid.uuid4().hex[:12]
    output = ROOT / ".e2e-downloads" / ("numbering-tabs-" + identity)
    output.mkdir(parents=True)
    remote = "/tmp/paper-math-" + identity
    run("docker", "exec", args.container, "mkdir", "-p", remote)
    native = (HERE.parent / "native.js").read_text(encoding="utf-8")
    core = (HERE.parent / "core.js").read_text(encoding="utf-8")
    fixture = (HERE / "docbuilder-numbering.js").read_text(encoding="utf-8")
    report = {}
    for name, stage, count, source, columns in [
        ("native-anchors", "native-anchors", 1, None, False),
        ("fonts", "font-inheritance", 3, None, False),
        ("fonts-reopened", "font-reopen", 3, "fonts", False),
        ("new", "create", 6, None, False),
        ("new-reopened", "reopen", 6, "new", False),
        ("columns", "columns", 3, None, True),
        ("columns-reopened", "reopen", 3, "columns", True),
        ("converted", "legacy", 3, None, False),
        ("converted-reopened", "reopen", 3, "converted", False),
    ]:
        start = f'builderJS.OpenFile("{remote}/{source}.docx");' if source else 'builderJS.CreateFile("docx");'
        script = output / (name + ".js")
        script.write_text(start + "\n" + native + "\n" + core + "\n" + fixture, encoding="utf-8")
        run("docker", "cp", str(script), args.container + ":" + remote + "/" + name + ".js")
        argument = {"stage": stage, "output": remote + "/" + name, "count": count}
        command = ["docker", "exec", args.container, "/var/www/onlyoffice/documentserver/server/FileConverter/bin/docbuilder", "--argument=" + json.dumps(argument)]
        if args.fonts_dir:
            command.append("--fonts-dir=" + args.fonts_dir)
        log = run(*command, remote + "/" + name + ".js")
        assert '"stage":' in log and "CHECK " in log, log
        for extension in ("docx", "pdf"):
            run("docker", "cp", args.container + ":" + remote + "/" + name + "." + extension, str(output / (name + "." + extension)))
        report[name] = inspect_fonts(output / (name + ".docx")) if name.startswith("fonts") else inspect(output / (name + ".docx"), count, columns)
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": list(report), "artifacts": str(output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
