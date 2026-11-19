// -*- coding: utf-8 -*-
// builderSetBibliography（文献托管块替换）回归：
// 非破坏预检（修订痕迹/批注/书签/非段落节点/接口缺失/标记形态）→ 全结构快照
// → 原位恢复（逐段落位+节点数+终验）→ 追加失败清理 → 终验。
// 对照 ONLYOFFICE 10.0.0.169 API 契约的 mock——只验证宏逻辑本身；
// 真实 DS 的故障注入与保存回读属人工验收（见 docs/E2E.md）。
const {test, describe} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// refs.js 是浏览器插件（require 会执行 boot 代码）——从源码文本按括号配平
// 提取 builderSetBibliography 函数体，在 vm 沙箱内以 mock Api 执行。
const refsSource = fs.readFileSync(path.join(__dirname, '..', 'refs.js'), 'utf8');
const fnStart = refsSource.indexOf('function builderSetBibliography(payload) {');
assert.ok(fnStart >= 0, 'refs.js 中未找到 builderSetBibliography');
let depth = 0, fnEnd = -1;
for (let i = fnStart; i < refsSource.length; i++) {
  if (refsSource[i] === '{') depth++;
  else if (refsSource[i] === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
}
const builderSetBibliography = refsSource.slice(fnStart, fnEnd);
assert.ok(builderSetBibliography.endsWith('}'), '函数体提取完整');

const HEAD = '[参考文献-平台生成]（由文献面板管理；删除此标记前请先在面板更新）';
const TAIL = '[参考文献-平台生成]（完）';

function makeRun(text) {
  const r = {
    text: String(text),
    AddText(t) { this.text = String(t); return true; },
    // 样式继承（P1-0-A）：默认无读取接口（typeof 检查跳过）；opts 注入后可读
    _fontName: null,
    _fontSize: null,
    SetFontName(n) { this._fontName = String(n); return true; },
    SetFontSize(s) { this._fontSize = s; return true; },
    GetFontName() { return this._fontName; },
    GetFontSize() { return this._fontSize; },
  };
  return r;
}

function makePara(text, opts = {}) {
  const p = {
    _parent: null,
    runs: [makeRun(String(text))],
    _tag: opts.tag || '',
    _json: opts.json || null,
    _class: opts.classType || 'paragraph',
    deleteOk: opts.deleteOk !== false,
    insertOk: opts.insertOk !== false,
    italic: !!opts.italic,
    flakyTexts: opts.flakyTexts || null,  // 联动域模拟：GetText 按调用次序返回序列（末值钳制）
    flakyCalls: 0,
    _isNew: false,
    _appliedStyle: null,  // 记录 SetStyle/SetSpacingBetween 沿用结果（样式继承断言用）
    GetClassType: () => p._class,
    GetText: () => {
      if (p.flakyTexts) {
        const t = p.flakyTexts[Math.min(p.flakyCalls, p.flakyTexts.length - 1)];
        p.flakyCalls += 1;
        return t;
      }
      return p.runs.map((r) => r.text).join('');
    },
    GetTag: () => p._tag,
    SetTag: (t) => { p._tag = t; },
    GetElement: (i) => p.runs[i],
    SetStyle: (s) => { p._appliedStyle = s; return true; },
    GetStyle: () => (opts.styleObj !== undefined ? opts.styleObj : null),
    SetSpacingBetween: (v, _mode) => { p._appliedSpacing = v; return true; },
    GetSpacingBetween: () => (opts.spacing !== undefined ? opts.spacing : null),
    ToJSON: () => (p._json !== null ? p._json : JSON.stringify({type: p._class, text: p.GetText(), italic: p.italic})),
    Delete: () => {
      if (!p.deleteOk) return false;
      const i = p._parent.items.indexOf(p);
      if (i >= 0) {
        p._parent.items.splice(i, 1);
        // 模拟真实 DS 约束：删除全部内容后自动保留一个空段
        if (p._parent.items.length === 0 && p._parent.keepEmptyOnEmpty) {
          const empty = makePara('');
          if (p._parent.keepEmptyDeleteFail) empty.deleteOk = false;  // 注入：自动保留的空段删不掉
          empty._parent = p._parent;
          p._parent.items.push(empty);
        }
      }
      return true;
    },
    InsertParagraph: (newP, _pos, returnNew) => {
      const n = (p._parent._insCalls = (p._parent._insCalls || 0) + 1);
      if (p._parent.insertThrowFrom != null && n - 1 === p._parent.insertThrowFrom) {
        throw new Error('InsertParagraph 注入异常（第 ' + n + ' 次调用）');
      }
      if (!p.insertOk) return null;
      const i = p._parent.items.indexOf(p);
      if (i < 0) return false;
      newP._parent = p._parent;
      p._parent.items.splice(i + 1, 0, newP);
      // 注入：DS 在落位时改写新段内容（位置达到阈值后），模拟「落位成功但内容失真」
      if (p._parent.corruptInsertedFrom != null && newP._isNew && i + 1 >= p._parent.corruptInsertedFrom) {
        newP.runs[0].text += '！';
      }
      return returnNew ? newP : true;
    },
    AddElement: (r) => { p.runs.push(r); return true; },
  };
  if (opts.fontName !== undefined) p.runs[0]._fontName = opts.fontName;
  if (opts.fontSize !== undefined) p.runs[0]._fontSize = opts.fontSize;
  return p;
}

function makeDoc(paras, opts = {}) {
  const doc = {
    items: paras,
    GetElementsCount: () => paras.length,
    GetElement: (i) => paras[i],
    Push: (p) => {
      if (opts.pushFailAfter != null && paras.length >= opts.pushFailAfter) return;  // 静默不落盘
      p._parent = doc;
      paras.push(p);
    },
    InsertParagraph: (p2, _pos) => { p2._parent = doc; paras.push(p2); },
    AddElement: (i, p) => {
      p._parent = doc;
      paras.splice(i, 0, p);
      // 与锚点插入同一注入：按位置落位的新段也会被 DS 侧改写
      if (opts.corruptInsertedFrom != null && p._isNew && i >= opts.corruptInsertedFrom) {
        p.runs[0].text += '！';
      }
      return true;
    },
    GetAllComments: () => opts.comments || [],
    IsTrackRevisions: () => !!opts.revisions,
    keepEmptyOnEmpty: !!opts.keepEmptyOnEmpty,  // DS 约束：删空后自动保留空段
    keepEmptyDeleteFail: !!opts.keepEmptyDeleteFail,  // 注入：自动保留的空段删除失败
    corruptInsertedFrom: opts.corruptInsertedFrom != null ? opts.corruptInsertedFrom : null,  // 注入：落位即改写新段
    insertThrowFrom: opts.insertThrowFrom != null ? opts.insertThrowFrom : null,  // 注入：第 N 次插入直接抛异常
    _insCalls: 0,
    Document: {Ru: opts.bookmarks || {We() {}, u_: () => 0, Eo: () => null}},
  };
  paras.forEach((p) => { p._parent = doc; });
  return doc;
}

function makeApi(doc, opts = {}) {
  const api = {
    GetDocument: () => doc,
    CreateParagraph: () => {
      const p = makePara('');
      p._isNew = true;  // 新块段落标记：与 FromJSON 还原段区分，供落位改写注入识别
      if (opts.cleanupDeleteFail) p.deleteOk = false;  // 注入：本次新建段落无法删除
      p._parent = doc;
      return p;
    },
    CreateRun: () => makeRun(''),
    FromJSON: (json) => {
      if (opts.fromJSONFail) throw new Error('FromJSON 注入失败');
      const o = JSON.parse(json);
      // 全结构还原（含 rPr/斜体/缩进/全文）：_json 回填使 ToJSON 保真可断言
      return makePara(o.text || '', {italic: !!o.italic, json: json});
    },
    ToJSON: (o) => o.ToJSON(),
  };
  return api;
}

function call(builderFn, doc, api, payload) {
  const sandbox = {Api: api, Asc: undefined, payload};
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${builderFn})(payload)`, sandbox)));
}
function callThrows(builderFn, doc, api, payload) {
  let err = null;
  try {
    vm.runInNewContext(`(${builderFn})(payload)`, {Api: api, Asc: undefined, payload});
  } catch (e) { err = e; }
  assert.ok(err, '预期宏抛错（保留现场），实际未抛');
  return err;
}
const texts = (doc) => doc.items.map((p) => (p.GetText ? p.GetText() : String(p)));

test('新格式块整块替换成功：头/条目/尾逐段落位且标签保留', () => {
  const doc = makeDoc([makePara('正文段落'), makePara(HEAD), makePara('[1] 旧甲', {tag: 'paper-bibliography'}), makePara('[2] 旧乙', {tag: 'paper-bibliography'}), makePara(TAIL)]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新甲', '[2] 新乙', '[3] 新丙']});
  assert.equal(r.ok, true);
  assert.equal(r.replaced, true);
  assert.deepEqual(texts(doc), ['正文段落', HEAD, '[1] 新甲', '[2] 新乙', '[3] 新丙', TAIL]);
});

test('旧格式块（无尾标记）拒绝自动迁移且正文零修改', () => {
  const doc = makeDoc([makePara('用户的 [2] 开头正文'), makePara(HEAD), makePara('[1] 旧')]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /旧版参考文献块/);
  assert.deepEqual(texts(doc), ['用户的 [2] 开头正文', HEAD, '[1] 旧']);
});

test('修订模式拒绝且零修改', () => {
  const doc = makeDoc([makePara(HEAD), makePara('[1] 甲', {tag: 'paper-bibliography'}), makePara(TAIL)], {revisions: true});
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /修订模式/);
  assert.equal(doc.items.length, 3);
});

test('修订关闭但快照含历史修订痕迹：递归拒绝且零修改', () => {
  const itemJson = JSON.stringify({type: 'paragraph', reviewType: 'removed', text: '[1] 修订痕迹'});
  const doc = makeDoc([makePara(HEAD), makePara('[1] 修订痕迹', {tag: 'paper-bibliography', json: itemJson}), makePara(TAIL)]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /未处理的修订记录/);
  assert.equal(doc.items.length, 3);
});

test('嵌套在 run 级的修订痕迹同样被递归拒绝', () => {
  const nestedJson = JSON.stringify({type: 'paragraph', text: '[1] 甲', content: [{type: 'run', reviewType: 'deleted'}]});
  const doc = makeDoc([makePara(HEAD), makePara('[1] 甲', {tag: 'paper-bibliography', json: nestedJson}), makePara(TAIL)]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /未处理的修订记录/);
  assert.equal(doc.items.length, 3);
});

test('批注存在拒绝且零修改', () => {
  const doc = makeDoc([makePara(HEAD), makePara('[1] 甲', {tag: 'paper-bibliography'}), makePara(TAIL)], {comments: [{}]});
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /批注/);
  assert.equal(doc.items.length, 3);
});

test('非 _GoBack 书签拒绝；仅 _GoBack 放行', () => {
  const docA = makeDoc([makePara(HEAD), makePara('[1] 甲', {tag: 'paper-bibliography'}), makePara(TAIL)],
    {bookmarks: {We() {}, u_: () => 2, Eo: (i) => (i === 0 ? 'bm-引文锚' : '_GoBack')}});
  const rA = call(builderSetBibliography, docA, makeApi(docA), {items: ['[1] 新']});
  assert.equal(rA.ok, false);
  assert.match(rA.message, /书签/);
  assert.equal(docA.items.length, 3);

  const docB = makeDoc([makePara(HEAD), makePara('[1] 甲', {tag: 'paper-bibliography'}), makePara(TAIL)],
    {bookmarks: {We() {}, u_: () => 1, Eo: () => '_GoBack'}});
  const rB = call(builderSetBibliography, docB, makeApi(docB), {items: ['[1] 新']});
  assert.equal(rB.ok, true);
});

test('托管区含表格节点拒绝且零修改', () => {
  const doc = makeDoc([makePara(HEAD), makePara('[1] 甲', {tag: 'paper-bibliography'}), makePara('', {classType: 'table'}), makePara(TAIL)]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /非段落节点/);
  assert.equal(doc.items.length, 4);
});

test('缺 FromJSON / 无效 JSON / 错误节点类型：修改前拒绝', () => {
  const doc = makeDoc([makePara(HEAD), makePara('[1] 甲', {tag: 'paper-bibliography'}), makePara(TAIL)]);
  const api = makeApi(doc);
  delete api.FromJSON;
  const r = call(builderSetBibliography, doc, api, {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /FromJSON/);
  assert.equal(doc.items.length, 3);

  const doc2 = makeDoc([makePara(HEAD), makePara('[1] 甲', {tag: 'paper-bibliography', json: '{oops 不是 JSON'}), makePara(TAIL)]);
  const r2 = call(builderSetBibliography, doc2, makeApi(doc2), {items: ['[1] 新']});
  assert.equal(r2.ok, false);
  assert.match(r2.message, /序列化异常/);
  assert.equal(doc2.items.length, 3);

  const doc3 = makeDoc([makePara(HEAD), makePara('[1] 甲', {tag: 'paper-bibliography', json: JSON.stringify({type: 'table', text: '[1] 甲'})}), makePara(TAIL)]);
  const r3 = call(builderSetBibliography, doc3, makeApi(doc3), {items: ['[1] 新']});
  assert.equal(r3.ok, false);
  assert.match(r3.message, /序列化异常/);
  assert.equal(doc3.items.length, 3);
});

test('删除失败：2204 字符斜体条目按全结构快照完整恢复', () => {
  const longText = '[2] ' + '长'.repeat(2200);
  const longJson = JSON.stringify({type: 'paragraph', text: longText, italic: true});
  const doc = makeDoc([makePara('正文'), makePara(HEAD), makePara(longText, {tag: 'paper-bibliography', json: longJson, deleteOk: false}), makePara(TAIL)]);
  const api = makeApi(doc);
  const r = call(builderSetBibliography, doc, api, {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /已按快照恢复原状/);
  assert.match(r.message, /未写入新块/);
  // 逐段核验：顺序、2204 长度、斜体结构、标签
  assert.deepEqual(texts(doc), ['正文', HEAD, longText, TAIL]);
  assert.equal(doc.items[2].GetText().length, 2204);
  assert.equal(JSON.parse(doc.items[2].ToJSON()).italic, true);
  assert.equal(doc.items[2].GetTag(), 'paper-bibliography');
});

test('长格式段被真正删除后在其前遇到删除失败：全结构还原且位置正确', () => {
  // 删除自尾向头：TAIL、长段都被真正删除，随后 [1] 甲 删除失败 → failIdx=2 →
  // 从快照还原长段（2204 字符斜体）与尾标记，位置逐一对齐
  const longText = '[2] ' + '长'.repeat(2200);
  const longJson = JSON.stringify({type: 'paragraph', text: longText, italic: true});
  const doc = makeDoc([
    makePara('正文'),
    makePara(HEAD),
    makePara('[1] 甲', {tag: 'paper-bibliography', deleteOk: false}),
    makePara(longText, {tag: 'paper-bibliography', json: longJson}),
    makePara(TAIL),
  ]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /已按快照恢复原状/);
  assert.deepEqual(texts(doc), ['正文', HEAD, '[1] 甲', longText, TAIL]);
  assert.equal(doc.items[3].GetText().length, 2204);
  assert.equal(JSON.parse(doc.items[3].ToJSON()).italic, true);
  assert.equal(doc.items[3].GetTag(), 'paper-bibliography');
});

test('恢复失败（InsertParagraph 返回 null）：抛错保留现场，引导撤销而非刷新', () => {
  const item = makePara('[1] 甲', {tag: 'paper-bibliography', deleteOk: false, insertOk: false});
  const tail = makePara(TAIL);
  const doc = makeDoc([makePara('正文'), makePara(HEAD), item, tail]);
  const api = makeApi(doc);
  const err = callThrows(builderSetBibliography, doc, api, {items: ['[1] 新']});
  assert.match(String(err), /恢复未完成/);
  assert.doesNotMatch(String(err), /刷新/);
  assert.match(String(err), /Ctrl\+Z/);
});

test('写入失败：仅清理本次插入节点并恢复旧块，附录位置不变', () => {
  // corruptInsertedFrom=1：原位写入的第 1 段落位即被改写 → 按位校验失败 →
  // 清理只删本次写入的 [head, head+insertedOk)，附录/正文原样，随后按快照恢复旧块
  const doc = makeDoc(
    [makePara('正文'), makePara(HEAD), makePara('[1] 旧', {tag: 'paper-bibliography'}), makePara(TAIL), makePara('附录一')],
    {corruptInsertedFrom: 1},
  );
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /已清理本次写入节点并按快照恢复旧块/);
  assert.match(r.message, /附录与正文位置不变/);
  assert.deepEqual(texts(doc), ['正文', HEAD, '[1] 旧', TAIL, '附录一']);
});

test('写入失败且清理也失败：抛错保留现场，不得宣称无净变更', () => {
  // corruptInsertedFrom=0：头标记落位即被改写 → 写入校验失败；
  // cleanupDeleteFail：本次新段删除必然失败 → 清理未完成 → 抛错保留现场
  const doc = makeDoc(
    [makePara(HEAD), makePara('[1] 旧', {tag: 'paper-bibliography'}), makePara(TAIL)],
    {corruptInsertedFrom: 0},
  );
  const api = makeApi(doc, {cleanupDeleteFail: true});
  const err = callThrows(builderSetBibliography, doc, api, {items: ['[1] 新']});
  assert.doesNotMatch(String(err), /无净变更|已清理本次写入节点并按快照恢复旧块/);
  assert.match(String(err), /清理.*未完成|恢复.*未完成/);
});

test('块外附录写入后自变：终验拦截进入统一恢复，旧块完整还原', () => {
  // 附录段模拟联动域：定位/快照时读「附录一」，终验时已自变「附录一 v2」——
  // 新块逐段正确也会被块外终验拦下 → 清理新块 + 恢复旧块（附录的自变内容原样保留）
  const appendix = makePara('附录一', {flakyTexts: ['附录一', '附录一', '附录一 v2']});
  const doc = makeDoc([
    makePara('正文'),
    makePara(HEAD),
    makePara('[1] 旧', {tag: 'paper-bibliography'}),
    makePara(TAIL),
    appendix,
  ]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /块外内容核验不符/);
  assert.match(r.message, /已清理本次写入节点并按快照恢复旧块/);
  assert.equal(doc.items.length, 5);
  assert.deepEqual(texts(doc).slice(0, 4), ['正文', HEAD, '[1] 旧', TAIL]);
  assert.equal(doc.items[4].GetText(), '附录一 v2');
});

test('孤立尾标记连续更新两次：两次都拒绝且不新增段落', () => {
  const doc = makeDoc([makePara('正文'), makePara(TAIL)]);
  const api = makeApi(doc);
  const r1 = call(builderSetBibliography, doc, api, {items: ['[1] 新']});
  assert.equal(r1.ok, false);
  assert.match(r1.message, /孤立的结束标记/);
  const r2 = call(builderSetBibliography, doc, api, {items: ['[1] 新']});
  assert.equal(r2.ok, false);
  assert.equal(doc.items.length, 2);  // 正文 + 孤立尾，无新增
});

test('整文档托管块 + DS 删空自动补空段：接受补位空段，新块写在空段之前', () => {
  const doc = makeDoc(
    [makePara(HEAD), makePara('[1] 旧', {tag: 'paper-bibliography'}), makePara(TAIL)],
    {keepEmptyOnEmpty: true},
  );
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, true);
  // DS「删一补一」无法排尽：排空检测到数量未减即停止，新块按位写在补位空段之前
  assert.deepEqual(texts(doc), [HEAD, '[1] 新', TAIL, '']);
});

test('自动保留空段删除失败：恢复旧块并如实报告残留空段', () => {
  const doc = makeDoc(
    [makePara(HEAD), makePara('[1] 旧', {tag: 'paper-bibliography'}), makePara(TAIL)],
    {keepEmptyOnEmpty: true, keepEmptyDeleteFail: true},
  );
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /自动保留空段/);
  assert.match(r.message, /已按快照恢复旧块/);
  // 新块未写入；旧块完整还原，残留的自动空段落位文末（如实报告，不静默丢弃）
  assert.deepEqual(texts(doc), [HEAD, '[1] 旧', TAIL, '']);
});

// ---------- 块外异常形态（本轮审查问题 3/4/5 的回归） ----------

test('块后有附录：原位替换成功，附录位置与内容保持不变', () => {
  const doc = makeDoc([
    makePara('正文'),
    makePara(HEAD),
    makePara('[1] 旧甲', {tag: 'paper-bibliography'}),
    makePara('[2] 旧乙', {tag: 'paper-bibliography'}),
    makePara(TAIL),
    makePara('附录一'),
    makePara('附录二'),
  ]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新甲', '[2] 新乙', '[3] 新丙']});
  assert.equal(r.ok, true);
  assert.equal(r.replaced, true);
  // 新块原位替换（3 条目），附录仍紧随其后、位置与内容不变
  assert.deepEqual(texts(doc), ['正文', HEAD, '[1] 新甲', '[2] 新乙', '[3] 新丙', TAIL, '附录一', '附录二']);
});

test('块外有无 GetText 的表格：更新成功且表格按类型核验保留', () => {
  const tbl = makePara('', {classType: 'table'});
  delete tbl.GetText;  // ONLYOFFICE 表格接口无 GetText（本轮审查问题 4 的形态）
  const doc = makeDoc([makePara(HEAD), makePara('[1] 旧', {tag: 'paper-bibliography'}), makePara(TAIL), tbl]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, true);
  assert.equal(doc.items.length, 4);
  const last = doc.items[3];
  assert.equal(last.GetClassType(), 'table');
  assert.equal(typeof last.GetText, 'undefined');
});

function nestedRevisionJson(depth) {
  let o = {type: 'paragraph', text: '[1] 深处', reviewType: 'deleted'};
  for (let i = 0; i < depth; i += 1) o = {type: 'paragraph', text: '[1] 深处', child: o};
  return JSON.stringify(o);
}

test('修订嵌套超预算（14 层）：fail-closed 拒绝而非判为安全', () => {
  const doc = makeDoc([makePara(HEAD), makePara('[1] 深处', {tag: 'paper-bibliography', json: nestedRevisionJson(14)}), makePara(TAIL)]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /超出修订扫描预算/);
  assert.equal(doc.items.length, 3);  // 零修改
});

test('修订嵌套在预算内（12 层）：仍能识别并按修订拒绝', () => {
  const doc = makeDoc([makePara(HEAD), makePara('[1] 深处', {tag: 'paper-bibliography', json: nestedRevisionJson(12)}), makePara(TAIL)]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /未处理的修订记录/);
  assert.equal(doc.items.length, 3);  // 零修改
});

// ---------- 第十轮审查回归：用户空段 / 前置表格 / 插入抛异常 ----------

test('块后单个用户格式空段：更新成功且空段原位保留', () => {
  const doc = makeDoc([
    makePara('正文'),
    makePara(HEAD),
    makePara('[1] 旧', {tag: 'paper-bibliography'}),
    makePara(TAIL),
    makePara(''),       // 用户排版空段——不是 DS 补位段
    makePara('附录一'),
  ]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, true);
  assert.deepEqual(texts(doc), ['正文', HEAD, '[1] 新', TAIL, '', '附录一']);
});

test('块后连续三个用户空段：全部原位保留', () => {
  const doc = makeDoc([
    makePara('正文'),
    makePara(HEAD),
    makePara('[1] 旧', {tag: 'paper-bibliography'}),
    makePara(TAIL),
    makePara(''),
    makePara(''),
    makePara(''),
    makePara('附录一'),
  ]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, true);
  assert.deepEqual(texts(doc), ['正文', HEAD, '[1] 新', TAIL, '', '', '', '附录一']);
});

test('前置表格（无 InsertParagraph/GetText）：按位置插入成功，表格保留', () => {
  const tbl = makePara('', {classType: 'table'});
  delete tbl.GetText;           // 真实表格无 GetText
  delete tbl.InsertParagraph;   // 真实表格无 InsertParagraph（本轮审查问题 2 的形态）
  const doc = makeDoc([tbl, makePara(HEAD), makePara('[1] 旧', {tag: 'paper-bibliography'}), makePara(TAIL)]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, true);
  assert.equal(doc.items.length, 4);
  const first = doc.items[0];
  assert.equal(first.GetClassType(), 'table');
  assert.equal(typeof first.GetText, 'undefined');
  assert.deepEqual(texts(doc).slice(1), [HEAD, '[1] 新', TAIL]);
});

test('首次原位插入抛异常：纳入统一恢复，旧块还原且不外抛', () => {
  const doc = makeDoc(
    [makePara('正文'), makePara(HEAD), makePara('[1] 旧', {tag: 'paper-bibliography'}), makePara(TAIL)],
    {insertThrowFrom: 0},
  );
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /异常/);
  assert.match(r.message, /已清理本次写入节点并按快照恢复旧块|无净变更未写入/);
  assert.deepEqual(texts(doc), ['正文', HEAD, '[1] 旧', TAIL]);
});

test('第二次原位插入抛异常：清理首段后恢复旧块，无半块残留', () => {
  const doc = makeDoc(
    [makePara('正文'), makePara(HEAD), makePara('[1] 旧', {tag: 'paper-bibliography'}), makePara(TAIL)],
    {insertThrowFrom: 1},
  );
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新']});
  assert.equal(r.ok, false);
  assert.match(r.message, /异常/);
  assert.deepEqual(texts(doc), ['正文', HEAD, '[1] 旧', TAIL]);
});

// ---------- P1-0-A：样式继承（旧块首条 → 新条目） ----------

test('样式继承：旧块首条的段落样式/字体/字号沿用到新条目段，标记段不沿用', () => {
  const styleObj = {name: 'Bibliography Style'};
  const doc = makeDoc([
    makePara('正文'),
    makePara(HEAD),
    makePara('[1] 旧', {tag: 'paper-bibliography', styleObj, fontName: '仿宋', fontSize: 10.5, spacing: 12}),
    makePara('[2] 旧', {tag: 'paper-bibliography'}),
    makePara(TAIL),
  ]);
  const r = call(builderSetBibliography, doc, makeApi(doc), {items: ['[1] 新甲', '[2] 新乙']});
  assert.equal(r.ok, true);
  assert.equal(r.replaced, true);
  // 新条目段（位置 2/3）沿用样式；mock 的 CreateParagraph 自带空 run，样式落在 CreateRun 上
  assert.deepEqual(doc.items[2]._appliedStyle, styleObj);
  const styledRun = doc.items[2].runs.find((r) => r._fontName === '仿宋');
  assert.ok(styledRun, '新条目 run 沿用字体');
  assert.equal(styledRun._fontSize, 10.5);
  assert.equal(doc.items[2]._appliedSpacing, 12);
  assert.deepEqual(doc.items[3]._appliedStyle, styleObj);
  // 头/尾标记段不沿用（_appliedStyle 保持 null）
  assert.equal(doc.items[1]._appliedStyle, null);
  assert.equal(doc.items[4]._appliedStyle, null);
});

// ---------- P1-0-A：builderCollectRefs（范围展开 / 表格扫描 / appear_order / 停扫） ----------

function extractFn(name) {
  const marker = 'function ' + name + '(';
  const start = refsSource.indexOf(marker);
  assert.ok(start >= 0, 'refs.js 中未找到 ' + name);
  let d = 0, end = -1;
  for (let i = start; i < refsSource.length; i++) {
    if (refsSource[i] === '{') d++;
    else if (refsSource[i] === '}') { d--; if (d === 0) { end = i + 1; break; } }
  }
  return refsSource.slice(start, end);
}
const builderCollectRefsSrc = extractFn('builderCollectRefs');
const builderStripBibMarkersSrc = extractFn('builderStripBibMarkers');

function callBuilderSrc(src, doc, api, payload) {
  const sandbox = {Api: api, Asc: undefined, payload};
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${src})(payload)`, sandbox)));
}

function makeTableCell(text) {
  const para = makePara(text);
  const content = {
    items: [para],
    GetElementsCount: () => content.items.length,
    GetElement: (i) => content.items[i],
  };
  const cell = {GetContent: () => content};
  const row = {GetCellsCount: () => 1, GetCell: () => cell};
  const table = {
    GetClassType: () => 'table',
    GetRowsCount: () => 1,
    GetRow: () => row,
  };
  return {table, para};
}

test('collect：范围写法 [1-3] 与混合 [1, 3-5] 展开', () => {
  const doc = makeDoc([makePara('引言[1-3]。'), makePara('方法[1, 3-5]。')]);
  const r = callBuilderSrc(builderCollectRefsSrc, doc, {GetDocument: () => doc}, {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.numbers, [1, 2, 3, 4, 5]);
  assert.deepEqual(r.appear_order, [1, 2, 3, 4, 5]);
  assert.equal(r.in_table_count, 0);
});

test('collect：em-dash/en-dash/unicode-minus 范围 [1–3] [3—5] [5−6] 同样展开', () => {
  const doc = makeDoc([makePara('甲[1–3]'), makePara('乙[3—5]'), makePara('丙[5−6]')]);
  const r = callBuilderSrc(builderCollectRefsSrc, doc, {GetDocument: () => doc}, {});
  assert.deepEqual(r.numbers, [1, 2, 3, 4, 5, 6]);
});

test('collect：年份区间 [2020-2024] 与孤立 [2020] 不展开、不误收', () => {
  const doc = makeDoc([makePara('文献 [2020-2024] 与 [2020] 的对比[1]。')]);
  const r = callBuilderSrc(builderCollectRefsSrc, doc, {GetDocument: () => doc}, {});
  assert.deepEqual(r.numbers, [1]);
  assert.deepEqual(r.appear_order, [1]);
});

test('collect：非法区间 [5-3] 与超跨度 [1-200] 拒收', () => {
  const doc = makeDoc([makePara('非法[5-3]与[1-200]但合法[2]。')]);
  const r = callBuilderSrc(builderCollectRefsSrc, doc, {GetDocument: () => doc}, {});
  assert.deepEqual(r.numbers, [2]);
});

test('collect：表格单元格内引用被收集并计 in_table_count', () => {
  const {table} = makeTableCell('见表 [2-3] 统计');
  const doc = makeDoc([makePara('正文 [1]'), table]);
  const r = callBuilderSrc(builderCollectRefsSrc, doc, {GetDocument: () => doc}, {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.numbers, [1, 2, 3]);
  assert.deepEqual(r.appear_order, [1, 2, 3]);
  assert.equal(r.in_table_count, 1);
});

test('collect：appear_order 按正文首次出现顺序（[2] 先于 [1] 可检出倒置）', () => {
  const doc = makeDoc([makePara('先 [2] 后 [1]')]);
  const r = callBuilderSrc(builderCollectRefsSrc, doc, {GetDocument: () => doc}, {});
  assert.deepEqual(r.numbers, [2, 1]);
  assert.deepEqual(r.appear_order, [2, 1]);
});

test('collect：遇托管块标记段停止，其后条目编号不算正文引用', () => {
  const doc = makeDoc([makePara('正文 [2]'), makePara(HEAD), makePara('[1] 条目甲'), makePara(TAIL)]);
  const r = callBuilderSrc(builderCollectRefsSrc, doc, {GetDocument: () => doc}, {});
  assert.deepEqual(r.numbers, [2]);
  assert.equal(r.stopped_at, 'marker');
});

test('collect：遇独立「参考文献/References」标题段停止，跳过其后条目区', () => {
  const doc = makeDoc([
    makePara('正文 [3]'),
    makePara('参考文献'),
    makePara('[1] 条目甲'),
    makePara('References'),
    makePara('[2] 条目乙'),
  ]);
  const r = callBuilderSrc(builderCollectRefsSrc, doc, {GetDocument: () => doc}, {});
  assert.deepEqual(r.numbers, [3]);
  assert.equal(r.stopped_at, 'heading');
});

// ---------- P1-0-A：builderStripBibMarkers ----------

test('strip：唯一一组标记被清理，中间条目与前后正文/附录原样保留', () => {
  const doc = makeDoc([
    makePara('正文'),
    makePara(HEAD),
    makePara('[1] 甲', {tag: 'paper-bibliography'}),
    makePara('[2] 乙', {tag: 'paper-bibliography'}),
    makePara(TAIL),
    makePara('附录一'),
  ]);
  const r = callBuilderSrc(builderStripBibMarkersSrc, doc, makeApi(doc), {});
  assert.equal(r.ok, true);
  assert.equal(r.removed, 2);
  assert.equal(r.entries, 2);
  assert.deepEqual(texts(doc), ['正文', '[1] 甲', '[2] 乙', '附录一']);
});

test('strip：无任何标记 → not_found 且零修改', () => {
  const doc = makeDoc([makePara('正文'), makePara('附录')]);
  const r = callBuilderSrc(builderStripBibMarkersSrc, doc, makeApi(doc), {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
  assert.deepEqual(texts(doc), ['正文', '附录']);
});

test('strip：孤立尾标记 / 重复头标记 / 标记倒置 → stale 拒绝且零修改', () => {
  const d1 = makeDoc([makePara('正文'), makePara(TAIL)]);
  const r1 = callBuilderSrc(builderStripBibMarkersSrc, d1, makeApi(d1), {});
  assert.equal(r1.ok, false);
  assert.match(r1.message, /孤立的结束标记/);
  assert.deepEqual(texts(d1), ['正文', TAIL]);

  const d2 = makeDoc([makePara(HEAD), makePara(HEAD), makePara(TAIL)]);
  const r2 = callBuilderSrc(builderStripBibMarkersSrc, d2, makeApi(d2), {});
  assert.equal(r2.ok, false);
  assert.match(r2.message, /重复的文献托管块标记/);
  assert.equal(d2.items.length, 3);

  const d3 = makeDoc([makePara(TAIL), makePara('[1] 甲'), makePara(HEAD)]);
  const r3 = callBuilderSrc(builderStripBibMarkersSrc, d3, makeApi(d3), {});
  assert.equal(r3.ok, false);
  assert.match(r3.message, /顺序倒置/);
  assert.equal(d3.items.length, 3);
});

test('strip：修订模式 / 标记段含修订痕迹 → 拒绝且零修改', () => {
  const d1 = makeDoc([makePara(HEAD), makePara('[1] 甲'), makePara(TAIL)], {revisions: true});
  const r1 = callBuilderSrc(builderStripBibMarkersSrc, d1, makeApi(d1), {});
  assert.equal(r1.ok, false);
  assert.match(r1.message, /修订模式/);
  assert.equal(d1.items.length, 3);

  const revJson = JSON.stringify({type: 'paragraph', text: HEAD, reviewType: 'removed'});
  const d2 = makeDoc([makePara(HEAD, {json: revJson}), makePara('[1] 甲'), makePara(TAIL)]);
  const r2 = callBuilderSrc(builderStripBibMarkersSrc, d2, makeApi(d2), {});
  assert.equal(r2.ok, false);
  assert.match(r2.message, /修订记录/);
  assert.equal(d2.items.length, 3);
});

test('strip：头标记删除失败 → 按快照恢复原状（尾标记复位），逐项核验通过', () => {
  const doc = makeDoc([
    makePara('正文'),
    makePara(HEAD, {deleteOk: false}),
    makePara('[1] 甲'),
    makePara(TAIL),
  ]);
  const r = callBuilderSrc(builderStripBibMarkersSrc, doc, makeApi(doc), {});
  assert.equal(r.ok, false);
  assert.match(r.message, /已按快照恢复原状/);
  assert.deepEqual(texts(doc), ['正文', HEAD, '[1] 甲', TAIL]);
});
