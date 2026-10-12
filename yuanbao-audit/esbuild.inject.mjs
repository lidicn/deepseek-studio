// yuanbao-audit 注入脚本打包
// src/inject-yuanbao/yuanbao-hook.ts → dist/yuanbao-hook.js（IIFE，浏览器，无外部依赖）
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });

await build({
  entryPoints: ['src/inject-yuanbao/yuanbao-hook.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: 'dist/yuanbao-hook.js',
  logLevel: 'info',
});

// 同时生成一个可直接粘贴到浏览器控制台的 loader（自动从 8761 获取 token）
const loader = `
// yuanbao-audit 注入 loader：在元宝页面控制台执行
(async () => {
  // 从配置获取 token（需要先启动 yuanbao-audit server）
  const token = window.__YUANBAO_TOKEN__ || prompt('请输入 yuanbao-audit token（config.json 里）');
  if (!token) return console.log('未提供 token');
  window.__YUANBAO_TOKEN__ = token;
  const res = await fetch('http://127.0.0.1:8761/v1/inject.js');
  const code = await res.text();
  eval(code);
  console.log('[yuanbao-audit] hook installed');
})();
`;
fs.writeFileSync(path.join(__dirname, 'dist/loader.js'), loader.trim());

console.log('[yuanbao-audit] inject build done → dist/yuanbao-hook.js');
