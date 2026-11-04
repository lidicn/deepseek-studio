// TD-04(a)：把 Node.js LTS 的 node.exe 拉到 src-tauri/node/node.exe（**不入库**，由 .gitignore 排除）。
//
// 为什么需要它：安装版必须自包含 —— 干净机器上没有 node 也得能起宿主。sidecar 的
// node 解析是三级优先「包内 bundled → STUDIO_NODE → PATH」，这个脚本负责生产「包内」那份。
//
// fail-closed 纪律（PM 明确要求）：
//   - 版本与 SHA256 写死在下面，**不符就直接 exit 1**，绝不静默降级成「用 PATH 的 node 打包」。
//     否则会打出一个「看起来内置、其实没内置」的包 —— 那比不内置更糟（用户以为能离线跑）。
//   - 已存在且哈希正确 → 跳过下载（幂等，CI 可缓存）。
//
// CI 诊断通道：所有失败都通过 `::error::` 工作流命令写进 check annotations——
//   GitHub job logs 接口需要管理员令牌，而 annotations 是公开 API 可读的（run#4 教训）。
//
// 镜像回退：nodejs.org 主源 + 两个镜像（npmmirror / 清华），各试一次。
//   同一个官方 zip，SHA256 校验兜底——镜像内容若被篡改，哈希不符直接 exit 1。
//
// 用法：`node src-tauri/fetch-node.mjs`（tauri build 前由 beforeBuildCommand / CI 独立步骤调用）
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

/** 锁死的 Node.js LTS 版本（win-x64）。换版本必须同时换 SHA256。 */
const NODE_VERSION = 'v24.22.2';
/** node.exe 的 SHA256（官方 win-x64 zip 内 node.exe，实测核对）。 */
const NODE_EXE_SHA256 =
  '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9';

/** 主源 + 镜像（同一官方产物；哈希校验是唯一信任边界）。 */
const MIRRORS = [
  `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`,
  `https://npmmirror.com/mirrors/node/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`,
  `https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`,
];

const here = path.dirname(fileURLToPath(import.meta.url));
const targetDir = path.join(here, 'node');
const targetExe = path.join(targetDir, 'node.exe');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 失败信息同时写 console 与 ::error:: 注解（annotations 公开 API 可读），再 exit 1。 */
function fail(msg) {
  console.error(`[fetch-node] FATAL: ${msg}`);
  console.error('[fetch-node] 构建中止（fail-closed）——不会用 PATH 的 node 冒充包内 node。');
  console.log(`::error::[fetch-node] ${msg}`);
  process.exit(1);
}

/** 诊断信息只进注解，不影响退出码。 */
function diag(msg) {
  console.log(`::notice::[fetch-node] ${msg}`);
}

// 幂等：已有且哈希正确 → 直接用
if (existsSync(targetExe)) {
  const cur = sha256(readFileSync(targetExe));
  if (cur === NODE_EXE_SHA256) {
    console.log(`[fetch-node] 已就绪（${NODE_VERSION}, ${statSync(targetExe).size} B），跳过下载`);
    process.exit(0);
  }
  // 注意：**不在这里删除**。旧文件可能是好的（比如期望哈希被误改），
  // 删除会把「本来能用的缓存」也毁掉。只有新文件校验通过后才覆盖它。
  console.warn(`[fetch-node] 现有 node.exe 哈希不符（${cur}），将重新下载；下载校验通过前不动它`);
}

try {
  diag(`env: platform=${process.platform} node=${process.version} cwd=${process.cwd()}`);

  if (process.platform !== 'win32') {
    fail(`本脚本只负责 win-x64 安装包；当前平台 ${process.platform}。`);
  }

  mkdirSync(targetDir, { recursive: true });
  const zipPath = path.join(os.tmpdir(), `node-${NODE_VERSION}-win-x64.zip`);

  let lastErr = '';
  let zipOk = false;
  // 两轮 × 三镜像：nodejs.org 在 Actions 上偶发「连接提前关闭导致 zip 截断」
  // （run#6：26,951,320 B 就正常 EOF，解压时 unexpected end of file），
  // 所以逐源校验 Content-Length，整轮失败再来一轮。
  const ROUNDS = 2;
  for (let round = 1; round <= ROUNDS && !zipOk; round++) {
    if (round > 1) {
      console.log(`[fetch-node] 第 ${round} 轮重试`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
    for (const url of MIRRORS) {
      try {
        console.log(`[fetch-node] 下载 ${url}`);
        const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
        if (!res.ok || !res.body) {
          let bodyHead = '';
          try { bodyHead = (await res.text()).slice(0, 200); } catch { /* ignore */ }
          lastErr = `HTTP ${res.status} ${res.statusText} from ${new URL(url).host} body="${bodyHead}"`;
          console.error(`[fetch-node] ${lastErr}`);
          continue; // 换下一个镜像
        }
        const contentLength = Number(res.headers.get('content-length') ?? 0);
        // 关键：close 只代表「上游流读完」，fs WriteStream 的 end() 是异步的——
        // 必须等 ws 的 finish 事件（全部数据刷盘）才能 stat，否则读到截断文件（run#7 根因）。
        await new Promise((resolve, reject) => {
          const ws = createWriteStream(zipPath);
          let settled = false;
          const done = () => { if (!settled) { settled = true; resolve(); } };
          const boom = (e) => { if (!settled) { settled = true; ws.destroy(); reject(e); } };
          res.body.pipeTo(new WritableStream({
            write(chunk) { ws.write(Buffer.from(chunk)); },
            close() { ws.end(); },
            abort(e) { boom(e); },
          })).catch(boom);
          ws.on('finish', done);
          ws.on('error', boom);
        });
        const size = statSync(zipPath).size;
        // 完整性校验：流可能「正常关闭」但其实被截断（run#6 根因）
        if (contentLength > 0 && size !== contentLength) {
          lastErr = `zip 截断：${new URL(url).host} 收到 ${size} B，Content-Length=${contentLength}`;
          console.error(`[fetch-node] ${lastErr}`);
          continue; // 换下一个镜像
        }
        diag(`downloaded ${size} B from ${new URL(url).host}`);
        zipOk = true;
        break;
      } catch (e) {
        lastErr = `download error from ${url}: ${e instanceof Error ? e.message : String(e)}`;
        console.error(`[fetch-node] ${lastErr}`);
      }
    }
  }
  if (!zipOk) fail(`全部镜像失败（含 ${ROUNDS} 轮重试）：${lastErr}`);

  // 从 zip 里精确取 `node-<version>-win-x64/node.exe`（不整体解压，避免路径匹配坑）
  const zipBuf = readFileSync(zipPath);
  const entry = `node-${NODE_VERSION}-win-x64/node.exe`;
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\3\4
  // 找 "PK\3\4" + 之后紧邻的文件名 == entry 的本地文件头
  let offset = -1;
  for (let i = 0; i + 30 <= zipBuf.length; i++) {
    if (zipBuf[i] !== sig[0] || zipBuf[i + 1] !== sig[1] || zipBuf[i + 2] !== sig[2] || zipBuf[i + 3] !== sig[3]) continue;
    const nameLen = zipBuf.readUInt16LE(i + 26);
    const extraLen = zipBuf.readUInt16LE(i + 28);
    const name = zipBuf.toString('utf8', i + 30, i + 30 + nameLen);
    if (name === entry) { offset = i; break; }
  }
  if (offset < 0) fail(`zip 内找不到 ${entry}（zip ${zipBuf.length} B）`);

  const compMethod = zipBuf.readUInt16LE(offset + 8);
  const compSize = zipBuf.readUInt32LE(offset + 18);
  const nameLen = zipBuf.readUInt16LE(offset + 26);
  const extraLen = zipBuf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLen + extraLen;
  const compData = zipBuf.subarray(dataStart, dataStart + compSize);

  let exeBuf;
  if (compMethod === 0) {
    exeBuf = compData; // stored
  } else if (compMethod === 8) {
    const { inflateRawSync } = await import('node:zlib');
    exeBuf = inflateRawSync(compData); // deflate
  } else {
    fail(`不支持的压缩方法 ${compMethod}`);
  }

  const got = sha256(exeBuf);
  if (got !== NODE_EXE_SHA256) {
    fail(`node.exe 哈希不符：期望 ${NODE_EXE_SHA256}，实际 ${got}`);
  }
  // 只写校验通过的内容
  writeFileSync(targetExe, exeBuf);
  rmSync(zipPath, { force: true });
  console.log(`[fetch-node] OK ${NODE_VERSION} → ${targetExe} (${exeBuf.length} B, sha256 校验通过)`);
} catch (e) {
  fail(`未捕获异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
}
