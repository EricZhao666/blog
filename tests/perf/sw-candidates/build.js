// Batch 6B：候选 Service Worker 生成器（测量用，不进生产）
//
// 把 tests/perf/sw-candidates/sw-variant.js 顶部的 CONFIG 块替换成指定取值，
// 得到一份可直接注入的候选脚本。仓库 sw.js 始终不动。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const VARIANT = path.join(__dirname, 'sw-variant.js');

// 'hotStart=swr' 或 'hotStart=timeout,hotStartTimeoutMs=150'（也接受 JSON 字符串）
function parseSwConfig(text) {
  if (text.trim().charAt(0) === '{') return JSON.parse(text);
  const out = {};
  text.split(',').map(s => s.trim()).filter(Boolean).forEach((kv) => {
    const i = kv.indexOf('=');
    if (i === -1) throw new Error('配置需要 key=value 形式: ' + kv);
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim();
    out[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v)
      : (/^(true|false)$/.test(v) ? v === 'true' : v.replace(/^['"]|['"]$/g, ''));
  });
  return out;
}

function buildSwCandidate(swConfig, swFile) {
  const srcPath = swFile ? path.resolve(ROOT, swFile) : VARIANT;
  const src = fs.readFileSync(srcPath, 'utf8');
  const cfg = Object.assign({ prefetch: 'immediate', prefetchDelayMs: 4000, hotStart: 'network-first', hotStartTimeoutMs: 300 }, swConfig || {});
  const block = 'const CONFIG = ' + JSON.stringify(cfg, null, 2) + ';\n';
  const out = swFile ? src : src.replace(/const CONFIG = \{[\s\S]*?\n\};\n/, block);
  if (!swFile && out === src) throw new Error('候选 CONFIG 替换失败: ' + srcPath);
  return {
    // 直接给文件时不知道它内部有哪些开关，别把默认值当成实际配置记录下来
    config: swFile ? null : cfg,
    configNote: swFile ? '直接使用文件内容（未做 CONFIG 替换）' : 'CONFIG 替换后的候选配置',
    sourcePath: path.relative(ROOT, srcPath).replace(/\\/g, '/'),
    source: out,
    bytes: Buffer.byteLength(out),
    sha256: crypto.createHash('sha256').update(out).digest('hex').slice(0, 16)
  };
}

module.exports = { buildSwCandidate, parseSwConfig, ROOT, VARIANT };
