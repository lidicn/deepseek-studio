/**
 * Lever-Hub Node 后端
 *
 * HTTP:8762，包装 Lever-Hub 的 Python 工具链：
 *   GET  /healthz              健康检查
 *   GET  /v1/applications      列出申请单
 *   GET  /v1/applications/:id  读取申请单
 *   POST /v1/applications      创建申请单
 *   PUT  /v1/applications/:id  编辑申请单
 *   DELETE /v1/applications/:id 删除申请单
 *   GET  /v1/lane              车道锁状态
 *   POST /v1/intake            生成需求稿（调用 intake.py）
 *   POST /v1/send              投喂 MiMo（调用 send.py）
 *   GET  /v1/outputs           列出回收件
 *   POST /v1/extract           从回收件提取代码
 */

import http from 'node:http';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const LEVER_HUB_PORT = 8762;
export const LEVER_HUB_HOST = '127.0.0.1';
export const LEVER_HUB_ROOT = 'E:/NAS/Lever-Hub';
export const PYTHON = 'C:/Users/lidicn/AppData/Local/Programs/Python/Python313/python.exe';

const MAX_BODY = 10 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => reject(new Error('body timeout')), 30_000);
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        clearTimeout(timer);
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString()); });
    req.on('error', reject);
  });
}

/** 运行 Python 脚本，捕获 stdout/stderr */
function runPython(args: string[], cwd = LEVER_HUB_ROOT, timeoutMs = 300_000): Promise<{
  code: number | null; stdout: string; stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, args, { cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`python timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    proc.on('error', reject);
  });
}

function listMarkdownFiles(dir: string): Array<{ name: string; size: number; mtime: number }> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export interface LeverHubServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createLeverHubServer(): LeverHubServer {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${LEVER_HUB_HOST}:${LEVER_HUB_PORT}`);
    const p = url.pathname;

    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    try {
      if (p === '/healthz') {
        json(200, { ok: true, service: 'lever-hub' });
        return;
      }

      // 列出申请单
      if (p === '/v1/applications' && req.method === 'GET') {
        json(200, { applications: listMarkdownFiles(path.join(LEVER_HUB_ROOT, '申请')) });
        return;
      }

      // 创建申请单
      if (p === '/v1/applications' && req.method === 'POST') {
        const body = await readBody(req);
        let data: { filename?: unknown; content?: unknown };
        try { data = JSON.parse(body); } catch { json(400, { error: 'invalid json' }); return; }
        if (typeof data.filename !== 'string' || typeof data.content !== 'string') {
          json(400, { error: 'filename and content required' });
          return;
        }
        const safe = data.filename.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff.]/g, '_');
        const file = path.join(LEVER_HUB_ROOT, '申请', safe);
        fs.writeFileSync(file, data.content, 'utf8');
        json(201, { ok: true, file: safe });
        return;
      }

      // 单个申请单：GET 读取 / PUT 编辑 / DELETE 删除
      if (p.startsWith('/v1/applications/') && ['GET', 'PUT', 'DELETE'].includes(req.method ?? '')) {
        const name = decodeURIComponent(p.substring('/v1/applications/'.length));
        const safeName = name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff.]/g, '_');
        const file = path.join(LEVER_HUB_ROOT, '申请', safeName);
        if (!fs.existsSync(file)) { json(404, { error: 'not found' }); return; }

        if (req.method === 'GET') {
          json(200, { name: safeName, content: fs.readFileSync(file, 'utf8') });
          return;
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          let data: { content?: unknown };
          try { data = JSON.parse(body); } catch { json(400, { error: 'invalid json' }); return; }
          if (typeof data.content !== 'string') { json(400, { error: 'content required' }); return; }
          fs.writeFileSync(file, data.content, 'utf8');
          json(200, { ok: true, file: safeName });
          return;
        }
        // DELETE
        fs.unlinkSync(file);
        json(200, { ok: true, deleted: safeName });
        return;
      }

      // intake：生成需求稿
      if (p === '/v1/intake' && req.method === 'POST') {
        const body = await readBody(req);
        let data: { application?: unknown };
        try { data = JSON.parse(body); } catch { json(400, { error: 'invalid json' }); return; }
        if (typeof data.application !== 'string') {
          json(400, { error: 'application filename required' });
          return;
        }
        const appPath = path.join('申请', data.application);
        const result = await runPython(['-u', 'intake.py', appPath], LEVER_HUB_ROOT, 60_000);
        json(result.code === 0 ? 200 : 500, {
          ok: result.code === 0,
          stdout: result.stdout.slice(-3000),
          stderr: result.stderr.slice(-3000),
        });
        return;
      }

      // send：投喂
      if (p === '/v1/send' && req.method === 'POST') {
        const body = await readBody(req);
        let data: { doc?: unknown; auto?: unknown };
        try { data = JSON.parse(body); } catch { json(400, { error: 'invalid json' }); return; }
        if (typeof data.doc !== 'string') { json(400, { error: 'doc path required' }); return; }
        const args = ['-u', 'send.py', '--doc', data.doc];
        if (data.auto === true) args.push('--auto');
        // 投喂+回收可能需要 3-5 分钟
        const result = await runPython(args, LEVER_HUB_ROOT, 600_000);
        json(result.code === 0 ? 200 : 500, {
          ok: result.code === 0,
          stdout: result.stdout.slice(-5000),
          stderr: result.stderr.slice(-5000),
        });
        return;
      }

      // 车道状态：out/.lane.lock 是否存在（3.5）
      if (p === '/v1/lane' && req.method === 'GET') {
        const lock = path.join(LEVER_HUB_ROOT, 'out', '.lane.lock');
        if (!fs.existsSync(lock)) {
          json(200, { occupied: false });
          return;
        }
        const stat = fs.statSync(lock);
        json(200, {
          occupied: true,
          holder: fs.readFileSync(lock, 'utf8').trim().slice(0, 500),
          since: stat.mtimeMs,
        });
        return;
      }

      // 列出回收件
      if (p === '/v1/outputs' && req.method === 'GET') {
        json(200, { outputs: listMarkdownFiles(path.join(LEVER_HUB_ROOT, 'out')) });
        return;
      }

      // 提取代码
      if (p === '/v1/extract' && req.method === 'POST') {
        const body = await readBody(req);
        let data: { output?: unknown; language?: unknown };
        try { data = JSON.parse(body); } catch { json(400, { error: 'invalid json' }); return; }
        if (typeof data.output !== 'string') { json(400, { error: 'output filename required' }); return; }
        const lang = typeof data.language === 'string' ? data.language : 'python';
        const content = fs.readFileSync(path.join(LEVER_HUB_ROOT, 'out', data.output), 'utf8');
        const blocks: string[] = [];
        const re = new RegExp('```' + lang + '\\n([\\s\\S]*?)\\n```', 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) blocks.push(m[1]);
        json(200, { ok: true, blocks, count: blocks.length });
        return;
      }

      json(404, { error: `not found: ${req.method} ${p}` });
    } catch (err) {
      json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(LEVER_HUB_PORT, LEVER_HUB_HOST, () => resolve());
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
