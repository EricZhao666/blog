// B5-01 / B5-02：Markdown 净化 与 动态事件/属性编码
// 只使用本地无害标记数据，不做任何真实漏洞利用。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8146;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name + (extra !== undefined ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  (' + extra + ')' : '')); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

server.listen(PORT, async () => {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => { if (!/Not implemented|Could not load script/i.test(e.message)) errors.push(e.message); });
  let dom;
  try {
    dom = await JSDOM.fromURL('http://localhost:' + PORT + '/index.html', {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc
    });
    const { window } = dom;
    await new Promise(r => window.addEventListener('load', r));
    await wait(300);

    const html = (md) => window.eval('renderMarkdown(' + JSON.stringify(md) + ')');

    // ---------- 1. 危险内容必须被移除 ----------
    const evil = [
      '<img src=x onerror="alert(1)">',
      '<a href="javascript:alert(1)">x</a>',
      '<script>alert(1)</script>',
      '<iframe src="https://example.com"></iframe>',
      '<div onclick="alert(1)">t</div>',
      '<svg><animate onbegin="alert(1)"/></svg>'
    ];
    let joined = evil.map(html).join('\n');
    check('M1 移除 onerror 等内联事件', !/onerror\s*=/i.test(joined), joined.slice(0, 40));
    check('M2 移除 javascript: 协议', !/javascript:/i.test(joined));
    check('M3 移除 script/iframe', !/<script/i.test(joined) && !/<iframe/i.test(joined));
    check('M4 移除内联 onclick', !/onclick\s*=/i.test(joined));
    check('M5 移除 svg 事件', !/onbegin\s*=/i.test(joined));

    // ---------- 2. 正常 Markdown 不被破坏 ----------
    const md = [
      '# 标题一', '', '普通段落，含 `行内代码`。', '',
      '| A | B |', '| --- | --- |', '| 1 | 2 |', '',
      '- 列表项一', '- 列表项二', '',
      '```python', 'print("hi")', '```', '',
      '[站内](#/post/x) [站外](https://example.com/a)'
    ].join('\n');
    const good = html(md);
    check('M6 保留标题', /<h1[^>]*>标题一<\/h1>/.test(good), good.slice(0, 30));
    check('M7 保留表格', /<table[\s\S]*<td>1<\/td>/.test(good));
    check('M8 保留列表', /<ul>[\s\S]*列表项一/.test(good));
    check('M9 保留代码块与语言 class', /<code[^>]*class="[^"]*language-python/.test(good), (good.match(/<code[^>]*class="[^"]*"/) || [''])[0]);
    check('M10 保留行内代码', /<code>行内代码<\/code>/.test(good));
    check('M11 站内链接不加 target', /<a href="#\/post\/x"/.test(good));
    check('M12 站外链接加 noopener', /rel="noopener noreferrer"/.test(good) && /target="_blank"/.test(good));

    // ---------- 3. 动态标签/分类不再拼进内联事件 ----------
    const tagSrc = window.eval(`(function(){
      var allTags=[{name:"a'b\\"c",count:1}];
      var html=renderTags("a'b\\"c");
      return html;
    })()`);
    check('E1 标签云不再使用内联 onclick', !/onclick=/i.test(tagSrc), '');
    // 标签名一律经 escapeHtml 进入 data 属性（静态断言，避免依赖真实标签集）
    const appSrc0 = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
    check('E2 标签名进入 data 属性且被转义',
      /data-tag-link="\$\{escapeHtml\(t\.name\)\}"/.test(appSrc0),
      (tagSrc.match(/data-tag-link="[^"]*"/) || [''])[0]);

    // 课程/论文分类：数据是按需加载的，这里对渲染源码做静态断言即可
    const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
    check('E3 课程分类不再使用内联 onclick', !/onclick="setCategory/i.test(appSrc));
    check('E4 课程分类使用 data-category', /data-category="\$\{escapeHtml\(cat\)\}"/.test(appSrc));
    check('E5 论文分类不再使用内联 onclick', !/onclick="setPaperCategory/i.test(appSrc));
    check('E5b 论文分类使用 data-paper-category', /data-paper-category="\$\{escapeHtml\(cat\)\}"/.test(appSrc));

    // ---------- 4. 事件委托仍然可用 ----------
    // 用标签链接验证委托链路（只改 hash，不触发数据渲染）
    const nav = window.eval(`(function(){
      var host=document.createElement('div');
      host.innerHTML='<span data-tag-link="a\\'b (c)" role="button" tabindex="0">x</span>';
      document.body.appendChild(host);
      host.querySelector('[data-tag-link]').click();
      var h=location.hash;
      document.body.removeChild(host);
      return h;
    })()`);
    check('E6 点击 data-tag-link 正确编码跳转',
      nav === '#/tags/' + encodeURIComponent("a'b (c)"), nav);

    check('M13 无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  } catch (e) {
    console.error('SMOKE ERROR:', e && e.stack || e);
    fail++;
  }
  console.log('\n共 ' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  if (dom) dom.window.close();
  server.close();
  process.exit(fail ? 1 : 0);
});
