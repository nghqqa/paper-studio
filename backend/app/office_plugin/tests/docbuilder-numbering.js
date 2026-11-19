/* Executed by verify_numbering.py inside ONLYOFFICE Document Builder.
 * The runner prepends native.js and core.js after opening a scratch document. */
function check(value, message) {if (!value) throw new Error(message);}
var command = PaperStudioNativeNumbering.numberingCommand;
var coreCommand = PaperStudioMath.documentCommand;
var doc = Api.GetDocument();
if (Argument.stage === "native-anchors") {
  // A controlled caret/key event exercises the production Enter handler with
  // real Office objects. Browser selection, locks and undo remain separate QA.
  var p = doc.GetElement(0);
  p.AddElement(Api.CreateMath("a+b#(1)", "unicode"));
  p.GetRange().AddBookmark("eq_native");
  var paragraphId = p.GetInternalId(), handler, root = {};
  var actor = {Emb: 0, Undo: function () {throw new Error("unexpected rollback");}, asc_GetLocalTrackRevisions: function () {return false;}};
  var logic = {mk: function () {return {AT: {Lf: root, Ola: function () {return true;}, Te: function () {return false;}, S1: function () {return {aa: root};}}};}, lf: function () {return false;}, pd: function () {}, ld: function () {}, Ec: function () {}, Le: function () {}, Xf: function () {}, sb: actor};
  actor.wa = {La: logic};
  var getDocument = Api.GetDocument, attachEvent = Api.attachEvent;
  Api.GetDocument = function () {return {Document: logic, GetCurrentParagraph: function () {return p;}};};
  Api.attachEvent = function (_, callback) {handler = callback;};
  check(command({action: "install", sdkVersion: "10.0.0"}).enabled, "native adapter not installed");
  var event = {iq: 13, Tk: false, eH: false, vl: false, mnd: 0};
  handler.call(actor, event);
  check(event.iq === 0 && command({action: "status"}).count === 1, "native numbering failed");
  Api.GetDocument = getDocument; Api.attachEvent = attachEvent;
  check(p.GetInternalId() === paragraphId && doc.GetElement(0).GetInternalId() === paragraphId, "native numbering replaced paragraph identity");
  check(doc.GetAllBookmarksNames().indexOf("eq_native") >= 0, "native numbering dropped bookmark");
} else if (Argument.stage === "font-inheritance") {
  var p = doc.GetElement(0);
  p.SetFontSize(32); p.AddText("16 pt insertion context"); p.GetRange().MoveCursorToPos(0);
  command({action: "insert", value: "a+b#(1)"});
  p = doc.GetCurrentParagraph(); p.SetFontSize(24); p.GetRange().MoveCursorToPos(0);
  command({action: "insert", value: "\\frac{a}{b}#(2)"});
  p = doc.GetCurrentParagraph(); p.SetFontSize(21); p.GetRange().MoveCursorToPos(0);
  coreCommand({action: "insert", placement: "display", latex: "E=mc^2"});
  var sizes = coreCommand({action: "list"}).formulas.map(function (f) {return doc.GetAllParagraphs()[f.paragraphIndex].GetRange().GetTextPr().GetFontSize();});
  check(JSON.stringify(sizes) === "[32,24,21]", "formula insertion reset font size: " + JSON.stringify(sizes));
} else if (Argument.stage === "font-reopen") {
  var p = doc.GetElement(0); p.SetFontSize(40); p.GetRange().MoveCursorToPos(0);
  for (var i = 0; i < 2; i++) {
    var snapshot = coreCommand({action: "list"});
    coreCommand({action: "replace", target: snapshot.formulas[i], version: snapshot.version, latex: i === 0 ? "a-b" : "\\frac{a-b}{c}"});
  }
  var sizes = coreCommand({action: "list"}).formulas.map(function (f) {return doc.GetAllParagraphs()[f.paragraphIndex].GetRange().GetTextPr().GetFontSize();});
  check(JSON.stringify(sizes) === "[32,24,21]", "formula editing changed font size: " + JSON.stringify(sizes));
} else if (Argument.stage === "create") {
  doc.GetElement(0).AddText("No-table equation numbering");
  var longFormula = Array.from({length: 24}, function (_, i) {return "x_{" + (i + 1) + "}";}).join("+") + "=y#(5)";
  var values = ["E=mc^2#(1)", "\\frac{a-b}{c}#(2)", "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}#(3)", "\\sum_{i=1}^{n} x_i#(4)", longFormula, "x#（6）"];
  values.forEach(function (value) {check(command({action: "insert", value: value}).numbered, "insert failed");});
  doc.GetCurrentParagraph().AddText("Body text after equations.");
  var longEquation = coreCommand({action: "list"}).formulas[4];
  doc.GetAllParagraphs()[longEquation.paragraphIndex].GetRange().MoveCursorToPos(0);
  check(command({action: "number-next-line"}).changed, "long equation number did not move");
  check(!command({action: "number-next-line"}).changed, "long equation number moved twice");
} else if (Argument.stage === "columns") {
  var section = doc.GetElement(0).GetSection();
  section.SetEqualColumns(2, 360);
  ["E=mc^2#(1)", "\\frac{a-b}{c}#(2)", "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}#(3)"].forEach(function (value) {check(command({action: "insert", value: value}).numbered, "column insert failed");});
} else if (Argument.stage === "legacy") {
  doc.GetElement(0).AddText("Legacy formula conversion");
  var table = Api.CreateTable(3, 3);
  table.SetWidth("twips", 9360); table.SetTableLayout("fixed");
  ["Top", "Bottom", "Left", "Right", "InsideH", "InsideV"].forEach(function (side) {table["SetTableBorder" + side]("none", 0, 0, 0);});
  for (var c = 0; c < 3; c++) table.SetColumnWidth(c, (c === 1 ? 8400 : 480) * 635);
  var formulas = ["E=mc^2", "\\frac{a+b}{c}", "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}"];
  for (var r = 0; r < 3; r++) {
    for (var c = 0; c < 3; c++) {
      var cell = table.GetCell(r, c); cell.SetWidth("twips", c === 1 ? 8400 : 480);
      var p = cell.GetContent().GetElement(0);
      if (c === 1) {p.SetJc("center"); p.AddElement(Api.CreateMath(formulas[r], "latex"));}
      if (c === 2) {p.SetJc("right"); p.AddText("(" + (r + 1) + ")");}
    }
  }
  doc.Push(table);
  var before = coreCommand({action: "list"});
  table.GetCell(0, 1).GetContent().GetElement(0).GetRange().MoveCursorToPos(0);
  check(command({action: "convert-current"}).count === 3, "legacy conversion failed");
  var after = coreCommand({action: "list"});
  check(JSON.stringify(before.formulas.map(function (f) {return f.latex;})) === JSON.stringify(after.formulas.map(function (f) {return f.latex;})), "conversion changed math");
} else if (Argument.stage === "reopen") {
  var snapshot = coreCommand({action: "list"});
  check(snapshot.formulas.length === Number(Argument.count), "formula count changed on reopen");
  var target = snapshot.formulas[1];
  check(coreCommand({action: "replace", target: target, version: snapshot.version, latex: "\\frac{a-b}{c}"}).ok, "reopened fraction is not editable");
  check(coreCommand({action: "list"}).formulas.length === Number(Argument.count), "formula update changed count");
}
console.log("CHECK " + JSON.stringify({stage: Argument.stage, formulas: coreCommand({action: "list"}).formulas.length}));
builderJS.SaveFile("docx", Argument.output + ".docx");
builderJS.SaveFile("pdf", Argument.output + ".pdf");
builderJS.CloseFile();
