const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('../../../../frontend/node_modules/jsdom');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const core = fs.readFileSync(path.join(__dirname, '../charts-core.js'), 'utf8');
const panel = fs.readFileSync(path.join(__dirname, '../charts.js'), 'utf8');
const fid = 'fig-123-abcdef';
const snapshot = {id: fid, name: '<研究图>', data_url: 'data:image/png;base64,YQ==', width_px: 1200, height_px: 600, sha256: 'a'.repeat(64)};
const turn = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 4; i++) await turn(); }
function deferred() { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; }
function response(data, ok = true) {return {ok, json: async () => data};}

function create(t, responder) {
  const dom = new JSDOM(html, {url: 'https://paper.example/api/office-plugin/index.html', runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const w = dom.window, calls = [], writes = [];
  w.Asc = {plugin: {info: {documentCallbackUrl: 'http://app:8000/api/office/callback/word-paper-test/abcdefgh12345678?cap=private'}}};
  w.Editor = {RunMacro: async (fn, payload) => {writes.push(payload); return {ok: true};}};
  w.fetch = async (url, options) => {calls.push({url, options}); return responder(url, calls, options);};
  // 不 mock crypto：插件必须只用 getRandomValues（HTTP 不安全上下文也有），
  // 依赖 randomUUID/subtle 会在实验室 HTTP 内网直接崩。
  w.eval(core); w.eval(panel);
  const element = id => w.document.getElementById(id);
  const emit = (id, type) => element(id).dispatchEvent(new w.Event(type));
  const ready = () => w.document.dispatchEvent(new w.Event('paper-studio-editor-ready'));
  const choose = () => {element('charts-library-select').value = fid; emit('charts-library-select', 'change');};
  return {w, calls, writes, element, emit, ready, choose};
}

test('library is scoped to current project and inserts only after a fresh snapshot check', async t => {
  const h = create(t, url => response(url.includes('/word-image') ? snapshot : {figures: [{id: fid, name: snapshot.name}]}));
  assert.equal(h.element('charts-library-insert').disabled, true);
  h.ready(); await settle();
  assert.equal(h.calls[0].url, '/api/project-figures/word-paper-test');
  assert.equal(h.element('charts-library-select').options[1].textContent, '<研究图>');
  assert.equal(h.element('charts-library-select').querySelector('研究图'), null);
  h.choose(); await settle();
  assert.equal(h.element('charts-library-insert').disabled, false);
  h.emit('charts-library-insert', 'click'); h.emit('charts-library-insert', 'click');
  await settle();
  assert.equal(h.calls.filter(x => x.url.includes('/word-image')).length, 2);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].data_url, snapshot.data_url);
  assert.equal(h.writes[0].width, 80 * 36000);
  assert.equal(h.writes[0].height, 40 * 36000);
  assert.match(h.writes[0].name, /^paper-figure:fig-123-abcdef:aaaaaaaaaaaaaaaa:/);
  assert.match(h.element('charts-library-status').textContent, /请点击平台“保存”/);
  for (const {url, options} of h.calls) {
    assert.ok(!url.includes('private') && !url.includes('http://app'));
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
  }
});

test('an old selection response cannot restore the wrong picture', async t => {
  const first = deferred();
  const h = create(t, url => url.includes('/word-image') ? first.promise : response({figures: [{id: fid, name: 'A'}]}));
  h.ready(); await settle(); h.choose(); await settle();
  h.element('charts-library-select').value = '';
  h.emit('charts-library-select', 'change');
  first.resolve(response(snapshot)); await settle();
  assert.equal(h.element('charts-library-insert').disabled, true);
  assert.equal(h.element('charts-library-preview').children.length, 0);
});

test('deleted/changed images and stale document sessions never reach the insertion macro', async t => {
  for (const condition of ['deleted', 'changed', 'session']) {
    await t.test(condition, async t => {
      let count = 0;
      const h = create(t, url => {
        if (!url.includes('/word-image')) return response({figures: [{id: fid, name: 'A'}]});
        count++;
        if (count === 1) return response(snapshot);
        return condition === 'deleted' ? response({detail: '图表不存在'}, false) : response({...snapshot, sha256: 'b'.repeat(64)});
      });
      h.ready(); await settle(); h.choose(); await settle();
      if (condition === 'session') h.w.Asc.plugin.info.documentCallbackUrl = 'https://paper.example/api/office/callback/word-paper-other/abcdefgh99999999';
      h.emit('charts-library-insert', 'click'); await settle();
      assert.equal(h.writes.length, 0);
      assert.equal(h.element('charts-library-status').dataset.level, 'error');
    });
  }
});

test('an unconfirmed document operation never reports insertion success or retries', async t => {
  const h = create(t, url => response(url.includes('/word-image') ? snapshot : {figures: [{id: fid, name: 'A'}]}));
  h.w.Editor.RunMacro = async () => null;
  h.ready(); await settle(); h.choose(); await settle();
  h.emit('charts-library-insert', 'click'); await settle();
  assert.match(h.element('charts-library-status').textContent, /未返回确认/);
  assert.doesNotMatch(h.element('charts-library-status').textContent, /已插入/);
  // 结果未知：插入被锁定；重新选择（重建操作）后才允许再次插入。
  assert.equal(h.element('charts-library-insert').disabled, true);
  h.element('charts-library-select').value = fid;
  h.emit('charts-library-select', 'change'); await settle();
  assert.equal(h.element('charts-library-insert').disabled, false);
});

test('editing new chart data invalidates an older preview response', async t => {
  const rendered = deferred();
  const h = create(t, url => url === '/api/charts/render' ? rendered.promise : response({figures: []}));
  h.ready(); await settle();
  h.emit('charts-render', 'click'); await settle();
  h.element('charts-title').value = 'Changed';
  h.emit('charts-title', 'input');
  rendered.resolve(response({data_url: snapshot.data_url, bytes: 1, width_px: 1200, height_px: 600, sha256: 'a'.repeat(64)})); await settle();
  assert.equal(h.element('charts-insert').disabled, true);
  assert.equal(h.element('charts-preview').children.length, 0);
});

test('preview insertion reuses server-provided dimensions and digest, working without crypto.subtle', async t => {
  // 实验室内网 HTTP 页面没有 crypto.subtle/randomUUID；预览的尺寸与 sha256 必须来自渲染接口。
  const h = create(t, url => {
    if (url === '/api/charts/render') return response({data_url: snapshot.data_url, bytes: 2, width_px: 1200, height_px: 600, sha256: 'c'.repeat(64)});
    return response({figures: []});
  });
  h.ready(); await settle();
  h.emit('charts-render', 'click'); await settle();
  assert.match(h.element('charts-status').textContent, /预览已生成/);
  h.emit('charts-insert', 'click'); await settle();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].width, 80 * 36000);
  assert.equal(h.writes[0].height, 40 * 36000);
  assert.match(h.writes[0].name, /^paper-figure:preview:cccccccccccccccc:/);
  assert.ok(!h.calls.some(x => String(x.url).startsWith('data:')), 'never refetch the data URL');
});

test('a preview edit while the insert macro is pending does not corrupt the built payload', async t => {
  const macro = deferred();
  const h = create(t, url => {
    if (url === '/api/charts/render') return response({data_url: snapshot.data_url, bytes: 2, width_px: 1200, height_px: 600, sha256: 'c'.repeat(64)});
    return response({figures: []});
  });
  h.w.Editor.RunMacro = (fn, payload) => { h.writes.push(payload); return macro.promise; };
  h.ready(); await settle();
  h.emit('charts-render', 'click'); await settle();
  h.emit('charts-insert', 'click'); await settle();
  // 宏飞行中编辑数据：写入已在途，不允许再发第二个宏。
  h.element('charts-title').value = 'Changed';
  h.emit('charts-title', 'input');
  h.emit('charts-insert', 'click'); await settle();
  macro.resolve({ok: true}); await settle();
  assert.equal(h.writes.length, 1);
});

test('a session change while the fresh snapshot check is in flight aborts the library insert', async t => {
  let count = 0;
  const fresh = deferred();
  const h = create(t, url => {
    if (!url.includes('/word-image')) return response({figures: [{id: fid, name: 'A'}]});
    count++;
    return count === 1 ? response(snapshot) : fresh.promise;
  });
  h.ready(); await settle(); h.choose(); await settle();
  h.emit('charts-library-insert', 'click'); await settle();
  assert.equal(h.writes.length, 0, 'macro must wait for the fresh check');
  h.w.Asc.plugin.info.documentCallbackUrl = 'https://paper.example/api/office/callback/word-paper-other/abcdefgh99999999';
  fresh.resolve(response(snapshot)); await settle();
  assert.equal(h.writes.length, 0);
  assert.equal(h.element('charts-library-status').dataset.level, 'error');
});

test('missing editor project context is actionable and never guesses from query parameters', async t => {
  const h = create(t, () => {assert.fail('no request should be sent without context');});
  h.w.Asc.plugin.info = {documentId: 'unrelated-id'};
  h.ready(); await settle();
  assert.equal(h.element('charts-library-select').disabled, true);
  assert.equal(h.element('charts-library-status').dataset.level, 'error');
});
