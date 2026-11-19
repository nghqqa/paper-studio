const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {normalizeLatex, serverScriptUrl, configuredServerScriptUrl, startSdkHandshake, contextAddsInfo, documentCommand} = require('../core.js');

function math(latex) {
  return {GetClassType: () => 'math', GetText: () => latex};
}
function run(text, id = 'run') {
  return {GetClassType: () => 'run', GetText: () => text, GetInternalId: () => id};
}
function container(id, items, type = 'paragraph') {
  return {
    items,
    GetClassType: () => type,
    GetInternalId: () => id,
    GetElementsCount: () => items.length,
    GetElement: index => items[index],
    GetText: () => items.map(item => item.GetText ? item.GetText() : '').join(''),
    AddElement: (item, index = items.length) => {items.splice(index, 0, item); return true;},
    RemoveElement: index => {items.splice(index, 1); return true;},
    SetJc(value) {this.alignment = value;},
    SetFontSize(value) {this.fontSize = value;},
    GetRange() {const paragraph = this; return {MoveCursorToPos(position) {paragraph.caret = position; return true;},GetTextPr:()=>({GetFontSize:()=>paragraph.fontSize})};},
  };
}
function editor(paragraphs) {
  const doc = {GetAllParagraphs: () => paragraphs,
    GetCurrentParagraph: () => doc.currentParagraph,
    GetRangeBySelect:()=>({GetTextPr:()=>({GetFontSize:()=>doc.caretFontSize})}),
    InsertContent() {assert.fail('generic paragraph paste is unsafe for formula insertion');},
    AddMathEquation(latex, format) {
      this.nativeEquation = {latex, format};
      this.currentParagraph.AddElement(math(latex), this.caretIndex);
      return true;
    },
  };
  function attachParagraph(paragraph) {
    paragraph.InsertParagraph = (newParagraph, position, returnNew) => {
      assert.equal(position, 'after');
      const index = paragraphs.indexOf(paragraph);
      paragraphs.splice(index + 1, 0, attachParagraph(newParagraph));
      doc.siblingInsertion = {anchor: paragraph, paragraph: newParagraph};
      return returnNew ? newParagraph : paragraph;
    };
    return paragraph;
  }
  paragraphs.forEach(attachParagraph);
  doc.currentParagraph = paragraphs[0] || attachParagraph(container('empty', []));
  let nextId = 0;
  doc.createdParagraphs=[];
  const Api = {GetDocument: () => doc, CreateMath: latex => math(latex), CreateParagraph: () => {const p=attachParagraph(container('new-' + nextId++, []));doc.createdParagraphs.push(p);return p;}, CreateRun: () => ({text: null, AddText(value) {this.text = value; return true;}})};
  // Run the serialized macro without any closure or plugin environment. This is
  // the same boundary crossed by RunMacro/callCommand, not a direct function call.
  return {doc, Api, call(payload) {return JSON.parse(JSON.stringify(vm.runInNewContext('(' + documentCommand.toString() + ')(payload)', {Api, payload})));}};
}

test('normalizes copied math delimiters but keeps inner dollars and commands', () => {
  for (const input of ['$$ x^2 $$', '$x^2$', '\\[x^2\\]', '\\(x^2\\)', ' x^2 ']) assert.equal(normalizeLatex(input), 'x^2');
  assert.equal(normalizeLatex('\\text{cost \\$5}'), '\\text{cost \\$5}');
  assert.throws(() => normalizeLatex('$$ $$'), /请输入/);
  assert.throws(() => normalizeLatex('a'.repeat(20001)), /20,000/);
});

test('loads SDK only from a valid configured HTTP(S) server and preserves deployment prefix', () => {
  assert.equal(serverScriptUrl('https://docs.example.test/onlyoffice/'), 'https://docs.example.test/onlyoffice/sdkjs-plugins/v1/plugins.js');
  assert.equal(serverScriptUrl('http://localhost:9980'), 'http://localhost:9980/sdkjs-plugins/v1/plugins.js');
  for (const invalid of ['javascript:alert(1)', 'https://user:pass@example.test', 'https://example.test/?x=1', 'https://example.test/#x']) assert.throws(() => serverScriptUrl(invalid));
});

test('malicious query parameters never choose an executable SDK origin', async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({url, options});
    return {ok: true, json: async () => ({document_server_url: 'https://trusted-docs.example/onlyoffice'})};
  };
  const selected = await configuredServerScriptUrl(fetcher, 'https://paper.example/api/office-plugin/index.html?ds=https%3A%2F%2Fevil.example&document_server_url=https://evil.example#settings.json');
  assert.equal(selected, 'https://trusted-docs.example/onlyoffice/sdkjs-plugins/v1/plugins.js');
  assert.deepEqual(requests, [{url: 'https://paper.example/api/office-plugin/settings.json', options: {credentials: 'omit', cache: 'no-store', redirect: 'error'}}]);
});

test('settings load failures stop SDK loading instead of falling back to query input', async () => {
  const page = 'https://paper.example/api/office-plugin/index.html?ds=https://evil.example';
  await assert.rejects(configuredServerScriptUrl(async () => ({ok: false}), page), /无法读取/);
  await assert.rejects(configuredServerScriptUrl(async () => ({ok: true, json: async () => ({})}), page), /缺少/);
  await assert.rejects(configuredServerScriptUrl(async () => ({ok: true, json: async () => ({document_server_url: 'javascript:alert(1)'})}), page), /地址无效/);
});

test('late SDK initialization starts after settings fetch even if page load already fired', () => {
  let starts = 0;
  const host = {onload() {assert.equal(this, host); starts += 1;}};
  startSdkHandshake(host, 'complete');
  assert.equal(starts, 1);
  // A near-simultaneous natural event cannot initialize the SDK a second time.
  host.onload({type: 'load'});
  assert.equal(starts, 1);
});

test('early SDK initialization waits for natural page load and sends one handshake', () => {
  let starts = 0;
  const host = {onload() {starts += 1;}};
  startSdkHandshake(host, 'interactive');
  assert.equal(starts, 0);
  host.onload({type: 'load'});
  host.onload({type: 'load'});
  assert.equal(starts, 1);
});

test('lists formulas in table paragraphs and nested inline content controls', () => {
  const ctrl = container('ctrl', [run('inside '), math('a/b')], 'inlineLvlSdt');
  const paragraphs = [container('body', [run('正文 '), math('x^2')]), container('table-cell', [ctrl])];
  const e = editor(paragraphs);
  const result = e.call({action: 'list'});
  assert.equal(result.ok, true);
  assert.equal(result.formulas.length, 2);
  assert.deepEqual(result.formulas[1].path, [0, 1]);
  assert.equal(result.formulas[1].paragraphId, 'table-cell');
  assert.equal(JSON.stringify(result).includes('_parent'), false, 'must not serialize Office API wrappers');
});

test('updates one native formula in place without replacing surrounding text or paragraph format', () => {
  const p = container('p1', [run('left ', 'r1'), math('a/b'), run(' right', 'r2')]);
  p.alignment = 'left';
  const e = editor([p]);
  const snapshot = e.call({action: 'list'});
  const result = e.call({action: 'replace', latex: '\\frac{c}{d}', target: snapshot.formulas[0], version: snapshot.version});
  assert.equal(result.ok, true);
  assert.deepEqual(p.items.map(item => item.GetText()), ['left ', '\\frac{c}{d}', ' right']);
  assert.equal(p.alignment, 'left');
});

test('edits a formula inside an inline content control', () => {
  const ctrl = container('control', [run('prefix'), math('x')], 'inlineLvlSdt');
  const e = editor([container('p1', [ctrl])]);
  const snapshot = e.call({action: 'list'});
  assert.equal(e.call({action: 'replace', latex: 'y', target: snapshot.formulas[0], version: snapshot.version}).ok, true);
  assert.equal(ctrl.items[1].GetText(), 'y');
});

test('stale list rejects a write after prose changes, even when the formula remains at the same index', () => {
  const p = container('p1', [run('original'), math('x')]);
  const e = editor([p]);
  const snapshot = e.call({action: 'list'});
  p.items[0] = run('changed');
  const result = e.call({action: 'replace', latex: 'wrong', target: snapshot.formulas[0], version: snapshot.version});
  assert.equal(result.code, 'stale');
  assert.equal(p.items[1].GetText(), 'x');
});

test('stale list cannot update another identical formula after paragraph reorder or copy', () => {
  const p1 = container('p1', [math('x')]);
  const p2 = container('p2', [math('x')]);
  const paragraphs = [p1, p2];
  const e = editor(paragraphs);
  const snapshot = e.call({action: 'list'});
  paragraphs.reverse();
  assert.equal(e.call({action: 'replace', latex: 'wrong', target: snapshot.formulas[0], version: snapshot.version}).code, 'stale');
  assert.equal(p1.items[0].GetText(), 'x');
  assert.equal(p2.items[0].GetText(), 'x');
});

test('rejects target tampering even with an up-to-date content snapshot', () => {
  const p = container('p1', [math('a'), math('b')]);
  const e = editor([p]);
  const snapshot = e.call({action: 'list'});
  const target = {...snapshot.formulas[0], path: [1]};
  assert.equal(e.call({action: 'replace', latex: 'wrong', target, version: snapshot.version}).code, 'stale');
  assert.deepEqual(p.items.map(item => item.GetText()), ['a', 'b']);
});

test('failed insertion into a locked parent preserves the existing formula', () => {
  const p = container('p1', [math('original')]);
  p.AddElement = () => false;
  const e = editor([p]);
  const snapshot = e.call({action: 'list'});
  assert.throws(() => e.call({action: 'replace', latex: 'changed', target: snapshot.formulas[0], version: snapshot.version}), /不可编辑/);
  assert.equal(p.items[0].GetText(), 'original');
});

test('a failed old-element removal cleans up the newly inserted formula', () => {
  const p = container('p1', [math('original')]);
  const remove = p.RemoveElement;
  p.RemoveElement = index => index === 1 ? false : remove(index);
  const e = editor([p]);
  const snapshot = e.call({action: 'list'});
  assert.throws(() => e.call({action: 'replace', latex: 'changed', target: snapshot.formulas[0], version: snapshot.version}), /更新失败/);
  assert.deepEqual(p.items.map(item => item.GetText()), ['original']);
});

test('list navigation uses the deployed public range cursor API without selecting prose', () => {
  const p = container('p1', [run('preserve'), math('x')]);
  p.Select = () => assert.fail('must not select the complete paragraph');
  const e = editor([p]);
  const snapshot = e.call({action: 'list'});
  assert.equal(e.call({action: 'select', target: snapshot.formulas[0], version: snapshot.version}).ok, true);
  assert.equal(p.caret, 0);
  assert.equal(p.items.length, 2);
});

test('hosts without range navigation can still read a verified edit target safely', () => {
  const p = container('p1', [run('preserve'), math('x')]);
  delete p.GetRange;
  const e = editor([p]);
  const snapshot = e.call({action: 'list'});
  assert.equal(e.call({action: 'select', target: snapshot.formulas[0], version: snapshot.version}).located, false);
  assert.equal(e.call({action: 'replace', latex: 'y', target: snapshot.formulas[0], version: snapshot.version}).ok, true);
  assert.equal(p.items[0].GetText(), 'preserve');
});

test('inline input delegates to the native caret equation operation, preserving neighboring content', () => {
  const p = container('p1', [run('before ', 'r1'), run(' after', 'r2')]);
  const e = editor([p]);
  e.doc.caretIndex = 1;
  assert.equal(e.call({action: 'insert', latex: 'x^2', placement: 'inline'}).ok, true);
  assert.deepEqual(e.doc.nativeEquation, {latex: 'x^2', format: 'latex'});
  assert.deepEqual(p.items.map(item => item.GetText()), ['before ', 'x^2', ' after']);
});

test('standalone insertion uses a real sibling paragraph even when the caret is inside an existing formula', () => {
  const p = container('p1', [run('before ', 'r1'), math('existing'), run(' after', 'r2')]);
  const paragraphs = [p];
  const e = editor(paragraphs);
  e.doc.caretIsInsideMath = true;
  assert.equal(e.call({action: 'insert', latex: 'y^2', placement: 'display'}).ok, true);
  assert.deepEqual(p.items.map(item => item.GetText()), ['before ', 'existing', ' after']);
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[1].alignment, 'center');
  assert.equal(paragraphs[1].items[0].GetClassType(), 'math');
  assert.equal(paragraphs[1].items[0].GetText(), 'y^2');
});

test('standalone formulas inherit the effective caret size, including Chinese half-point sizes',()=>{
  for(const size of [21,24,32]) {
    const p=container('p1',[run('body')]);p.fontSize=22;
    const e=editor([p]);e.doc.caretFontSize=size;
    e.call({action:'insert',latex:'a+b',placement:'display'});
    assert.equal(e.doc.siblingInsertion.paragraph.fontSize,size);
    assert.equal(p.fontSize,22,'leave body formatting intact');
  }
});

test('paragraph style formatting supplies the size when caret and direct formatting are unavailable',()=>{
  const p=container('p1',[run('body')]);p.GetStyle=()=>({GetTextPr:()=>({GetFontSize:()=>24})});
  const e=editor([p]);e.call({action:'insert',latex:'a+b',placement:'display'});
  assert.equal(e.doc.siblingInsertion.paragraph.fontSize,24);
});

test('updating a uniformly formatted equation preserves its size independently of the current caret',()=>{
  const p=container('p1',[math('a+b'),run('(1)')]);p.fontSize=24;
  const e=editor([p]);e.doc.caretFontSize=40;
  const snapshot=e.call({action:'list'});
  e.call({action:'replace',latex:'a-b',target:snapshot.formulas[0],version:snapshot.version});
  assert.equal(e.doc.createdParagraphs.at(-1).fontSize,24);
  assert.equal(e.doc.createdParagraphs.at(-1).items[0],p.items[0]);
  assert.equal(p.items[1].GetText(),'(1)');
});

test('legacy callCommand bridge reads only the scoped JSON payload', () => {
  const e = editor([container('p1', [math('x')])]);
  const result = vm.runInNewContext('(' + documentCommand.toString() + ')()', {Api: e.Api, Asc: {scope: {paperStudioMathPayload: {action: 'list'}}}});
  assert.equal(result.ok, true);
  assert.equal(result.formulas[0].latex, 'x');
});

test('old Office API reports an actionable minimum-version error', () => {
  const e = editor([]);
  delete e.Api.CreateMath;
  assert.equal(e.call({action: 'list'}).code, 'unsupported');
});

test('numbered formulas expose their bracket labels from the trailing text runs', () => {
  const numbered = container('p1', [run('正文 '), math('x^2'), run('\t'), run('(2-1)')]);
  const plain = container('p2', [math('y=x')]);
  const result = editor([numbered, plain]).call({action: 'list'});
  assert.equal(result.formulas[0].label, '2-1');
  assert.equal(result.formulas[1].label, null);
});

test('suggest-label continues the latest prefix group and skips lettered tails', () => {
  const e = editor([
    container('p1', [math('a'), run('\t'), run('(2-1)')]),
    container('p2', [math('b'), run('\t'), run('(2-2)')]),
  ]);
  assert.equal(e.call({action: 'suggest-label'}).label, '2-3');
  assert.equal(editor([]).call({action: 'suggest-label'}).label, '1');
  const lettered = editor([container('p1', [math('a'), run('\t'), run('(1a)')])]);
  assert.equal(lettered.call({action: 'suggest-label'}).label, null);
});

test('check-refs classifies missing, duplicate and unreferenced equation labels', () => {
  const e = editor([
    container('prose', [run('由式(2)可知，另见式(9)。')]),
    container('p1', [math('a'), run('\t'), run('(2)')]),
    container('p2', [math('b'), run('\t'), run('(3)')]),
    container('p3', [math('c'), run('\t'), run('(2)')]),
  ]);
  const report = e.call({action: 'check-refs'});
  assert.equal(report.ok, true);
  assert.equal(report.missing.length, 1);
  assert.equal(report.missing[0].label, '9');
  assert.equal(report.missing[0].paragraphIndex, 0);
  assert.deepEqual(report.duplicates, ['2']);
  assert.deepEqual(report.unreferenced, ['3']);
});

test('renumber rewrites label runs sequentially per prefix and skips unrecognized structures', () => {
  const p1 = container('p1', [math('a'), run('\t'), run('(7)')]);
  const p2 = container('p2', [math('b'), run('\t'), run('(9)')]);
  const p3 = container('p3', [math('c'), run('\t'), run('(1a)')]);
  const e = editor([p1, p2, p3]);
  const version = e.call({action: 'list'}).version;
  const result = e.call({action: 'renumber', version});
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed.map(change => [change.from, change.to]), [['9', '8']]);
  assert.deepEqual(result.skipped, ['1a']);
  assert.equal(p1.items[2].GetText(), '(7)');
  assert.equal(p2.items[2].text, '(8)');
  assert.equal(p3.items[2].GetText(), '(1a)');
});

test('renumber rejects a stale snapshot without touching any label', () => {
  const p1 = container('p1', [math('a'), run('\t'), run('(7)')]);
  const e = editor([p1]);
  const result = e.call({action: 'renumber', version: 'out-of-date'});
  assert.equal(result.code, 'stale');
  assert.equal(p1.items[2].GetText(), '(7)');
});

test('contextAddsInfo hides standalone-paragraph context but keeps surrounding prose', () => {
  assert.equal(contextAddsInfo({latex: 'E=mc^2', label: '1', context: 'E=mc^2 (1)'}), false);
  assert.equal(contextAddsInfo({latex: 'E=mc^2', context: 'E=mc^2'}), false);
  assert.equal(contextAddsInfo({latex: 'E=mc^2', label: '1', context: '由式(1)可知 E=mc^2 (1)'}), true);
  assert.equal(contextAddsInfo({latex: 'x^2', context: '正文提到 x^2 与结论'}), true);
  assert.equal(contextAddsInfo({latex: 'a+b', context: ''}), false);
});
