const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../charts-core.js');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
const FID = 'fig-1792720000-abc123';
const SHA = 'a'.repeat(64);
const UUID = '00000000-0000-4000-8000-000000000001';
const CALLBACK = 'https://paper.example/api/office/callback/word-paper-1/word-key-123456?cap=private-capability';
const payload = (overrides = {}) => ({
  data_url: PNG,
  name: core.insertionName(FID, SHA, UUID),
  width: 100 * 36000,
  height: 60 * 36000,
  ...overrides,
});

// Model the published Office API contract: AddDrawing returns an ApiRun,
// InsertContent returns a boolean, and GetDrawingsByName accepts string[].
// Evaluate only the serialized command in a fresh realm: no module closure
// or test helper can accidentally make an editor command work.
function editor(overrides = {}) {
  const calls = { images: [], paragraphs: [], inserts: [], lookups: [] };
  const drawings = new Map();
  const anchor = {
    GetText: () => '\r\n',
    IsEmpty: () => true,
    GetAllDrawingObjects: () => [],
    GetParent: () => ({ GetClassType: () => 'document' }),
    GetParentTable: () => null,
    GetSection: () => ({ GetColumnsWidths: () => [9000] }),
    ...overrides.anchor,
  };
  const doc = {
    GetSelectedDrawings: () => [],
    GetRangeBySelect: () => ({ GetStartPos: () => 42, GetEndPos: () => 42 }),
    GetCurrentParagraph: () => anchor,
    GetDrawingsByName(names) {
      assert.ok(Array.isArray(names), 'official API requires an array of names');
      assert.ok(names.every((name) => typeof name === 'string'));
      calls.lookups.push(Array.from(names));
      return names.flatMap((name) => drawings.has(name) ? [drawings.get(name)] : []);
    },
    InsertContent(paragraphs, inline) {
      calls.inserts.push({ paragraphs, inline });
      for (const paragraph of paragraphs) {
        for (const image of paragraph.drawings) drawings.set(image.name, image);
      }
      return true;
    },
    ...overrides.doc,
  };
  const Api = {
    GetDocument: () => doc,
    CreateImage(src, width, height) {
      const image = {
        src, width, height,
        SetName(name) { this.name = name; return true; },
        GetName() { return this.name; },
        ...overrides.image,
      };
      calls.images.push(image);
      return image;
    },
    CreateParagraph() {
      const paragraph = {
        drawings: [],
        SetJc(value) { this.justification = value; return true; },
        AddDrawing(image) { this.drawings.push(image); return { GetClassType: () => 'run' }; },
        ...overrides.paragraph,
      };
      calls.paragraphs.push(paragraph);
      return paragraph;
    },
    ...overrides.Api,
  };
  function execute(value = payload(), throughScope = false) {
    const sandbox = { Api };
    if (throughScope) sandbox.Asc = { scope: { paperStudioChartPayload: value } };
    else sandbox.commandPayload = value;
    return vm.runInNewContext(
      `(${core.insertCommand.toString()})(${throughScope ? '' : 'commandPayload'})`,
      sandbox,
      { timeout: 1000 },
    );
  }
  return { Api, doc, anchor, calls, drawings, execute };
}

test('context takes validated path identifiers only, never query fields or callback authority', () => {
  const expected = { pid: 'word-paper-1', docKey: 'word-key-123456' };
  assert.deepEqual(core.context({ documentCallbackUrl: CALLBACK + '&pid=other&doc_key=other-key-999' }), expected);
  const external = core.context({
    documentCallbackUrl: 'https://untrusted.example/api/office/callback/word-paper-1/word-key-123456?cap=secret&url=https://other.example',
    pid: 'other', docKey: 'other-key-999',
  });
  assert.deepEqual(external, expected);
  assert.deepEqual(Object.keys(external).sort(), ['docKey', 'pid']);
  assert.ok(!JSON.stringify(external).includes('secret'));
  assert.ok(!JSON.stringify(external).includes('untrusted.example'));
  assert.throws(() => core.context({ documentCallbackUrl: 'https://paper.example/?pid=word-paper-1&doc_key=word-key-123456' }));
});

test('context rejects malformed URLs, schemes, path traversal and short session keys', () => {
  for (const url of [undefined, '', '/api/office/callback/p/key-123456',
    'file:///api/office/callback/p/key-123456', 'javascript:alert(1)',
    'https://paper.example/api/office/callback/p/short',
    'https://paper.example/api/office/callback/p%2Fother/key-123456',
    'https://paper.example/api/office/callback/p%5Cother/key-123456',
    'https://paper.example/api/office/callback/%ZZ/key-123456',
    'https://paper.example/api/office/callback/p/key-123456/extra']) {
    assert.throws(() => core.context({ documentCallbackUrl: url }), String(url));
  }
  assert.equal(core.sameContext(null, { pid: 'p', docKey: 'key' }), false);
  assert.equal(core.sameContext({ pid: 'p', docKey: 'one' }, { pid: 'p', docKey: 'two' }), false);
  assert.equal(core.sameContext({ pid: 'p', docKey: 'one' }, { pid: 'q', docKey: 'one' }), false);
});

test('imageSize uses EMUs and preserves aspect ratio without a fixed 16:9 distortion', () => {
  assert.deepEqual(core.imageSize(1200, 800, 90), { width: 3240000, height: 2160000 });
  assert.deepEqual(core.imageSize(800, 1200, 40), { width: 1440000, height: 2160000 });
  for (const dimensions of [[0, 100, 40], [100, -1, 40], [100, 100, 9], [100, 100, 161], [NaN, 100, 40], [100, Infinity, 40]]) {
    assert.throws(() => core.imageSize(...dimensions));
  }
});

test('insertion names distinguish repeated uses of one source image', () => {
  const first = core.insertionName(FID, SHA, UUID);
  const second = core.insertionName(FID, SHA, UUID.replace(/1$/, '2'));
  assert.notEqual(first, second);
  assert.ok(first.includes(FID));
  assert.ok(first.includes(SHA.slice(0, 16)));
  assert.throws(() => core.insertionName('../other', SHA, UUID));
  assert.throws(() => core.insertionName(FID, 'invalid-sha', UUID));
  assert.throws(() => core.insertionName(FID, SHA, 'short'));
});

test('serialized command inserts a named centered native image and reads it back by an array of names', () => {
  const e = editor();
  const input = payload();
  const result = e.execute(input);
  assert.equal(result.ok, true);
  assert.equal(result.name, input.name);
  assert.equal(e.calls.images.length, 1);
  assert.equal(e.calls.inserts.length, 1);
  assert.equal(e.calls.inserts[0].inline, false);
  assert.equal(e.calls.paragraphs[0].justification, 'center');
  assert.equal(e.drawings.get(input.name).src, PNG);
  assert.deepEqual(e.calls.lookups, [[input.name], [input.name]]);
});

test('serialized command clamps to the narrowest current section column using twips, preserving ratio', () => {
  const e = editor({ anchor: { GetSection: () => ({ GetColumnsWidths: () => [4500, 3900] }) } });
  const result = e.execute();
  assert.equal(result.ok, true);
  assert.equal(result.width, 3900 * 635);
  assert.equal(result.height, Math.round(3900 * 635 * 0.6));
  assert.equal(e.calls.images[0].width, result.width);
  assert.equal(e.calls.images[0].height, result.height);
});

test('serialized command does not upscale a smaller requested image to column width', () => {
  const e = editor();
  const result = e.execute(payload({ width: 40 * 36000, height: 20 * 36000 }));
  assert.equal(result.ok, true);
  assert.equal(result.width, 40 * 36000);
  assert.equal(result.height, 20 * 36000);
});

test('preflight guards preserve existing text, selections, pictures and table content', async (t) => {
  const cases = [
    ['nonempty paragraph', { anchor: { GetText: () => 'Existing paragraph\r\n' } }],
    ['selected text', { doc: { GetRangeBySelect: () => ({ GetStartPos: () => 2, GetEndPos: () => 10 }) } }],
    ['selected drawing', { doc: { GetSelectedDrawings: () => [{ GetClassType: () => 'image' }] } }],
    ['table cell', { anchor: { GetParent: () => ({ GetClassType: () => 'documentContent' }), GetParentTable: () => ({}) } }],
    ['table detected independently', { anchor: { GetParentTable: () => ({}) } }],
    ['header or footer', { anchor: { GetParent: () => ({ GetClassType: () => 'documentContent' }) } }],
    ['unknown selection contract', { doc: { GetRangeBySelect: () => ({}) } }],
    ['image-only nonempty paragraph', { anchor: { GetText: () => '\r\n', IsEmpty: () => false, GetAllDrawingObjects: () => [{}] } }],
  ];
  for (const [name, overrides] of cases) await t.test(name, () => {
    const e = editor(overrides);
    assert.equal(e.execute().ok, false);
    assert.equal(e.calls.images.length, 0, 'do not construct images until the insertion anchor is safe');
    assert.equal(e.calls.inserts.length, 0, 'do not mutate document content');
  });
});

test('invalid or unreadable section widths refuse insertion without a broad-width fallback', async (t) => {
  for (const columns of [[], [0], [-20], [NaN], [4000, Infinity], null]) await t.test(String(columns), () => {
    const e = editor({ anchor: { GetSection: () => ({ GetColumnsWidths: () => columns }) } });
    assert.equal(e.execute().ok, false);
    assert.equal(e.calls.inserts.length, 0);
  });
  const e = editor({ anchor: { GetSection: () => { throw new Error('no section'); } } });
  assert.equal(e.execute().ok, false);
  assert.equal(e.calls.inserts.length, 0);
});

test('existing insertion name prevents replay, while a new instance name allows another copy', () => {
  const e = editor();
  assert.equal(e.execute().ok, true);
  assert.equal(e.execute().ok, false);
  assert.equal(e.calls.inserts.length, 1);
  assert.equal(e.execute(payload({ name: core.insertionName(FID, SHA, UUID.replace(/1$/, '2')) })).ok, true);
  assert.equal(e.calls.inserts.length, 2);
  assert.equal(e.drawings.size, 2);
});

test('invalid image payloads fail before any document write', async (t) => {
  for (const overrides of [
    { data_url: 'https://untrusted.example/image.png' },
    { data_url: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { data_url: 'data:image/png;base64,***' },
    { data_url: 'data:image/png;base64,' + 'A'.repeat(7 * 1024 * 1024) },
    { name: 'ordinary-user-image' }, { width: 0 }, { height: NaN },
    { width: 161 * 36000 }, { height: 251 * 36000 },
  ]) await t.test(Object.keys(overrides).join(','), () => {
    const e = editor();
    assert.equal(e.execute(payload(overrides)).ok, false);
    assert.equal(e.calls.inserts.length, 0);
  });
});

test('missing editor capabilities fail without touching document content', async (t) => {
  for (const overrides of [
    { Api: { CreateImage: undefined } },
    { doc: { GetDrawingsByName: undefined } },
    { doc: { GetSelectedDrawings: undefined } },
    { doc: { GetRangeBySelect: undefined } },
    { anchor: { GetParent: undefined } },
  ]) await t.test(JSON.stringify(Object.keys(overrides)), () => {
    const e = editor(overrides);
    assert.equal(e.execute().ok, false);
    assert.equal(e.calls.inserts.length, 0);
  });
});

test('false or absent insertion results and ambiguous readback are never reported as success', async (t) => {
  for (const value of [false, null, undefined]) await t.test(String(value), () => {
    const e = editor({ doc: { InsertContent: () => value } });
    assert.equal(e.execute().ok, false);
    assert.equal(e.drawings.size, 0);
  });
  let checks = 0;
  const e = editor({ doc: { GetDrawingsByName: () => ++checks === 1 ? [] : [{}, {}] } });
  const result = e.execute();
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.equal(e.calls.inserts.length, 1, 'an uncertain result is not automatically retried');
});

test('the fallback transports serialized payload through Asc.scope without module globals', async () => {
  const e = editor();
  const host = { Asc: { scope: {}, plugin: {
    callCommand(command, close, recalculate, callback) {
      assert.equal(close, false);
      assert.equal(recalculate, true);
      callback(vm.runInNewContext(`(${command.toString()})()`, { Api: e.Api, Asc: host.Asc }, { timeout: 1000 }));
    },
  } } };
  const result = await core.runInsert(host, payload());
  assert.equal(result.ok, true);
  assert.equal(e.calls.inserts.length, 1);
});

test('RunMacro rejection does not fall back or repeat a possibly completed write', async () => {
  let macroCalls = 0, fallbackCalls = 0;
  const e = editor();
  const host = {
    Editor: { RunMacro(command, value) {
      macroCalls += 1;
      e.execute(value);
      return Promise.reject(new Error('reply lost after insertion'));
    } },
    Asc: { plugin: { callCommand() { fallbackCalls += 1; } } },
  };
  await assert.rejects(core.runInsert(host, payload()), /reply lost/);
  assert.equal(macroCalls, 1);
  assert.equal(e.calls.inserts.length, 1);
  assert.equal(fallbackCalls, 0);
});

test('missing transports reject and a synchronous macro exception does not trigger fallback', async () => {
  await assert.rejects(core.runInsert({}, payload()), /尚未连接/);
  let fallbacks = 0;
  assert.throws(() => core.runInsert({
    Editor: { RunMacro() { throw new Error('transport failure'); } },
    Asc: { plugin: { callCommand() { fallbacks += 1; } } },
  }, payload()), /transport failure/);
  assert.equal(fallbacks, 0);
});

// Exercise the user-facing success decision too: runInsert intentionally
// passes through the transport reply, and charts.js must reject false/null.
function panel(macroResult) {
  class Element {
    constructor() { this.value = ''; this.textContent = ''; this.dataset = {}; this.children = []; this.listeners = {}; }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    appendChild(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    async fire(name, event = {}) { for (const listener of this.listeners[name] || []) await listener(event); }
  }
  const elements = new Map();
  const document = new Element();
  document.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  document.createElement = () => new Element();
  document.getElementById('charts-width').value = '90';
  const requests = [];
  const snapshot = { id: FID, name: 'Research chart', data_url: PNG, sha256: SHA, width_px: 1200, height_px: 800 };
  let macroCalls = 0;
  const window = new Element();
  Object.assign(window, {
    PaperStudioCharts: core,
    Asc: { plugin: { info: { documentCallbackUrl: CALLBACK } } },
    crypto: {
      // The panel now derives uniqueness from getRandomValues (available in
      // insecure HTTP contexts where randomUUID/subtle are not).
      getRandomValues: (bytes) => { for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff; return bytes; },
    },
    Editor: { RunMacro() { macroCalls += 1; return Promise.resolve(macroResult); } },
  });
  const fetch = async (url) => {
    requests.push(url);
    assert.ok(url.startsWith('/api/project-figures/word-paper-1'), 'requests must use same-origin project routes');
    return { ok: true, json: async () => url.includes('/word-image?') ? snapshot : { figures: [snapshot] } };
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../charts.js'), 'utf8'), { window, document, fetch, URL }, { timeout: 1000 });
  return { elements, document, requests, macroCalls: () => macroCalls };
}

test('the chart panel refuses false/null/undefined macro replies and never claims a saved DOCX', async (t) => {
  for (const result of [false, null, undefined, { ok: false, message: 'Editor refused' }]) await t.test(String(result), async () => {
    const p = panel(result);
    await p.document.fire('paper-studio-editor-ready');
    await new Promise(setImmediate);
    p.elements.get('charts-library-select').value = FID;
    await p.elements.get('charts-library-select').fire('change');
    await p.elements.get('charts-library-insert').fire('click');
    assert.equal(p.macroCalls(), 1);
    const status = p.elements.get('charts-library-status');
    assert.equal(status.dataset.level, 'error');
    assert.doesNotMatch(status.textContent, /已插入|已保存/);
    // 结果未确认：锁定插入按钮，防止对可能已完成的写入连续重试。
    assert.equal(p.elements.get('charts-library-insert').disabled, true);
    assert.equal(p.requests.filter((url) => url.includes('/word-image?')).length, 2, 'recheck the snapshot just before insertion');
    // 重新建立操作（重新选择图表）后解锁，且重建的操作重新执行完整快照复核。
    p.elements.get('charts-library-select').value = FID;
    await p.elements.get('charts-library-select').fire('change');
    assert.equal(p.elements.get('charts-library-insert').disabled, false);
    await p.elements.get('charts-library-insert').fire('click');
    assert.equal(p.macroCalls(), 2);
    assert.equal(p.requests.filter((url) => url.includes('/word-image?')).length, 4, 'the rebuilt operation rechecks the snapshot again');
  });
});

test('a timed-out macro is reported as an unknown result and never retried or replaced', async () => {
  let macroCalls = 0;
  const host = { Editor: { RunMacro() { macroCalls += 1; return new Promise(() => {}); } } };
  await assert.rejects(() => core.runInsert(host, payload(), 15), /结果未知[\s\S]*检查正文/);
  assert.equal(macroCalls, 1);
  await assert.rejects(() => core.runInsert({ Asc: { scope: {}, plugin: { callCommand() { /* never calls back */ } } } }, payload(), 15), /结果未知/);
});

test('a resolved macro clears the timeout and synchronous returns are accepted', async () => {
  const done = await core.runInsert({ Editor: { RunMacro: () => ({ ok: true, name: 'x' }) } }, payload(), 15);
  assert.equal(done.ok, true);
  const sync = await core.runInsert({ Editor: { RunMacro: () => ({ ok: true }) } }, payload(), 15);
  assert.equal(sync.ok, true);
});

// ---- 正文图表更新通道 ----

function macroParagraph(items) {
  return {
    items,
    GetElementsCount: () => items.length,
    GetElement: (index) => items[index],
    AddElement: (item, index = items.length) => { items.splice(index, 0, item); return true; },
    RemoveElement: (index) => { items.splice(index, 1); return true; },
  };
}
function docImage(name, width, height) {
  return {
    GetClassType: () => 'image',
    GetName: () => name,
    GetWidth: () => width,
    GetHeight: () => height,
  };
}
function macroEditor(paragraphs, overrides = {}) {
  const calls = { created: [] };
  const doc = {
    GetAllParagraphs: () => paragraphs,
    GetDrawingsByName: (names) => (overrides.existing || []).filter((name) => names.includes(name)),
    ...overrides.doc,
  };
  const Api = {
    GetDocument: () => doc,
    CreateImage: (src, width, height) => {
      const image = { src, width, height, name: null, SetName(value) { this.name = value; return true; } };
      calls.created.push(image);
      return image;
    },
  };
  return { doc, Api, calls, call: (command, payload) => JSON.parse(JSON.stringify(vm.runInNewContext(`(${command.toString()})(payload)`, { Api, payload }))) };
}

test('parseInsertionName round-trips platform names and rejects foreign ones', () => {
  const name = core.insertionName(FID, SHA, UUID);
  const parsed = core.parseInsertionName(name);
  assert.deepEqual(parsed, { fid: FID, sha16: SHA.slice(0, 16) });
  for (const foreign of [null, '', 'Picture 1', 'paper-figure:preview:abc:def', `paper-figure:${FID}:zzzz:${UUID}`]) {
    assert.equal(core.parseInsertionName(foreign), null);
  }
});

test('inventory lists only platform-named images with parsed identities', () => {
  const stale = core.insertionName(FID, 'b'.repeat(64), UUID);
  const paragraphs = [
    macroParagraph([docImage('Picture 1', 10, 10), docImage(stale, 2880000, 1800000)]),
    macroParagraph([docImage('paper-figure:preview:0123456789abcdef:uuid-12345678', 10, 10)]),
  ];
  const e = macroEditor(paragraphs);
  const result = e.call(core.inventoryCommand, {});
  assert.equal(result.ok, true);
  assert.equal(result.total, 1);
  assert.deepEqual(result.figures[0], { name: stale, fid: FID, sha16: 'b'.repeat(16), paragraphIndex: 0, index: 1, width: 2880000, height: 1800000 });
});

test('replace swaps a stale drawing in place and keeps the rendered size', () => {
  const oldName = core.insertionName(FID, 'b'.repeat(64), UUID);
  const paragraph = macroParagraph([docImage(oldName, 3000000, 2000000)]);
  const e = macroEditor([paragraph]);
  const newName = core.insertionName(FID, SHA, UUID);
  const result = e.call(core.replaceCommand, {
    name: oldName, newName, data_url: PNG, width: 100 * 36000, height: 60 * 36000,
  });
  assert.equal(result.ok, true);
  assert.equal(paragraph.items.length, 1);
  assert.equal(paragraph.items[0].name, newName);
  assert.equal(paragraph.items[0].width, 3000000);
  assert.equal(paragraph.items[0].height, 2000000);
});

test('replace refuses mismatches: identical sha, fid drift, missing target, duplicate new name', () => {
  const oldName = core.insertionName(FID, 'b'.repeat(64), UUID);
  const base = { name: oldName, data_url: PNG, width: 36000, height: 36000 };
  const sameSha = { ...base, newName: core.insertionName(FID, 'b'.repeat(64), 'other-uuid-12345') };
  assert.equal(macroEditor([macroParagraph([docImage(oldName, 1, 1)])]).call(core.replaceCommand, sameSha).ok, false);
  const drifted = { ...base, newName: core.insertionName('fig-1792720000-fff999', SHA, UUID) };
  assert.equal(macroEditor([macroParagraph([docImage(oldName, 1, 1)])]).call(core.replaceCommand, drifted).ok, false);
  const missing = { ...base, newName: core.insertionName(FID, SHA, UUID) };
  assert.equal(macroEditor([macroParagraph([])]).call(core.replaceCommand, missing).ok, false);
  const fresh = { ...base, newName: core.insertionName(FID, SHA, UUID) };
  const duplicate = macroEditor([macroParagraph([docImage(oldName, 1, 1)])], { existing: [core.insertionName(FID, SHA, UUID)] });
  assert.equal(duplicate.call(core.replaceCommand, fresh).ok, false);
});
