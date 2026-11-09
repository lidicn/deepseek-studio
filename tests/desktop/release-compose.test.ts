/**
 * 发版流回归断言（P1-2：latest.json 的 url 自 0.14.0 起就是死链 —— 本地产物名带空格，
 * GitHub 把上传资产名的空格规范成点，compose 却用本地名拼 url → 客户端下载 404）。
 *
 * 这里守三件事，任何一条被改回去都必须红：
 *   ① 产物名归一化（空格→点）在 compose 之前，且两个 bundle 都覆盖；
 *   ② url 的 basename 来自**最终产物名**，前置闸再按 GitHub **实际资产名**复核；
 *   ③ 前置闸用**已上传的资产字节**跑 verify-sig.mjs（与客户端 verify_signature 同判据），
 *      失败删 draft（fail-closed）；发布后用公开 url 再验一遍，失败打回 draft。
 *
 * 负控（已实测）：删掉 release.yml 的归一化步，本文件第 1 条直接红。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
}

/** 取出 workflow 里名为 name 的那一步的正文（到下一个 `- name:` / 文件尾为止） */
function step(yaml: string, name: string): string {
  const start = yaml.indexOf(`- name: ${name}`);
  expect(start, `step not found: ${name}`).toBeGreaterThanOrEqual(0);
  const rest = yaml.slice(start + `- name: ${name}`.length);
  const next = rest.indexOf('\n      - ');
  return next === -1 ? rest : rest.slice(0, next);
}

const release = read('.github/workflows/release.yml');
const published = read('.github/workflows/release-published.yml');
const verifySig = read('src-tauri/verify-sig.mjs');

describe('P1-2：latest.json 的 url 必须与 GitHub 实际资产名一字不差', () => {
  it('构建后把 nsis/msi 产物名的空格改成点，并断言无空格残留', () => {
    const normalize = step(release, 'Normalize updater artifact names');
    expect(normalize).toContain('bundle/nsis/*.exe');
    expect(normalize).toContain('bundle/msi/*.msi');
    expect(normalize).toContain("$newName = $f.Name -replace ' ', '.'");
    expect(normalize).toContain('space-containing artifact names remain');
  });

  it('compose 的 url 取自最终产物名；产物名带空格直接失败', () => {
    const compose = step(release, 'Compose latest.json');
    expect(compose).toContain('bundle/nsis/*.exe');
    expect(compose).toContain("if ($nsis.Name -match ' ') { throw");
    // 20261107 注入面收口：url 改走 env 通道（SERVER_URL/REPOSITORY/TAG_NAME），
    // basename 仍来自最终产物名、路径仍含 tag（P1-2 原意不变）
    expect(compose).toContain('url = "$env:SERVER_URL/$env:REPOSITORY/releases/download/$tag/$($nsis.Name)"');
    // 注入回归锁（20261107）：run: 块内不许 ${{ }} 插值（单引号可进 tag 名 ⇒ 插值即代码执行）；
    // env:/with: 数据通道合法，不算违规。
    const runStart = compose.indexOf('run: |');
    expect(runStart, 'compose 无 run: 块').toBeGreaterThanOrEqual(0);
    expect(compose.slice(runStart), 'compose run: 块内出现 ${{ 插值').not.toContain('${{');
    // 旧写法（拿 productName / 配置里的名字拼 url）不许回来
    expect(compose).not.toContain('productName');
  });

  it('compose/Preflight/Delete-draft/Verify-tag 四步的 run: 脚本体内零插值（20261107 注入回归锁）', () => {
    // run: 块内不许有 ${{ }}（单引号可进 tag 名 ⇒ 插值即代码执行）；
    // env:/with: 数据通道合法（GH_TOKEN 等），不算违规。
    for (const name of ['Verify tag matches version', 'Compose latest.json', 'Preflight gate (G1/G2/G5)', 'Delete draft on failure (fail-closed)']) {
      const body = step(release, name);
      const runStart = body.indexOf('run: |');
      expect(runStart, `step '${name}' 无 run: 块`).toBeGreaterThanOrEqual(0);
      const runBody = body.slice(runStart);
      expect(runBody, `step '${name}' 的 run: 块内出现 \${{ 插值`).not.toContain('${{');
    }
  });

  it('步骤顺序：归一化 → compose → 建 draft → 前置闸', () => {
    const order = [
      'Normalize updater artifact names',
      'Compose latest.json',
      'Create draft release',
      'Preflight gate',
    ].map((label) => {
      const i = release.indexOf(`- name: ${label}`);
      expect(i, `missing step: ${label}`).toBeGreaterThanOrEqual(0);
      return i;
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('G1/G2/G5 前置闸：只认 GitHub 上的实际结果', () => {
  it('按 Release assets API 的实际资产名复核 url basename，并核对双产物 + .sig', () => {
    const gate = step(release, 'Preflight gate (G1/G2/G5)');
    // 查草稿必须走全量列表按 tag 过滤（GET /releases/tags/{tag} 不返回 draft，run#12 404 根因）
    expect(gate).toContain('/releases?per_page=100');
    expect(gate).toContain("$_.tag_name -eq $tag -and $_.draft");
    expect(gate).toContain("[uri]::UnescapeDataString(($plat.url -split '/')[-1])");
    expect(gate).toContain("if ($urlName -ne $nsis) { throw");
    expect(gate).toContain("@($nsis, \"$nsis.sig\", $msi, \"$msi.sig\", 'latest.json')");
    // 资产名带空格 = GitHub 会再改名 → 直接失败
    expect(gate).toContain("if ($n -match ' ') { throw");
    // 负控：两处（前置闸 + 闸失败清理）都不许回退到不返回 draft 的 tags 端点
    // （只禁真实 API URI 模式，不误咬「该端点不返回 draft」的注释原文）
    expect(gate).not.toContain('releases/tags/$tag');
    expect(release).not.toContain('$repo/releases/tags/');
  });

  it('下载已上传资产字节并跑 verify-sig.mjs（客户端 verify_signature 同判据）', () => {
    const gate = step(release, 'Preflight gate (G1/G2/G5)');
    expect(gate).toContain("Accept = 'application/octet-stream'");
    expect(gate).toContain('-Uri $asset.url -OutFile $tmp');
    expect(gate).toContain('node src-tauri/verify-sig.mjs --pubkey $conf.plugins.updater.pubkey --signature $plat.signature --file $tmp');
    expect(gate).toContain('if ($uploadedSize -ne $localSize) { throw');
  });

  it('闸失败删 draft（fail-closed），已发布的 Release 绝不删', () => {
    const cleanup = step(release, 'Delete draft on failure (fail-closed)');
    expect(release).toContain('if: failure()');
    // 与前置闸同坑：查草稿必须走全量列表按 tag 过滤（tags 端点不返回 draft）
    expect(cleanup).toContain('/releases?per_page=100');
    // 只匹配 draft=true：已发布的 Release 天然不命中，从构造上保证「绝不删已发布」
    expect(cleanup).toContain("$_.tag_name -eq $tag -and $_.draft");
    expect(cleanup).not.toContain('$repo/releases/tags/');
    expect(cleanup).toContain('-Method Delete');
  });
});

describe('发布后公开链路闸（G4：draft 的公开 url 恒 404，只能在 publish 之后真 HEAD）', () => {
  it('挂在 release: published 上', () => {
    expect(published).toContain('types: [published]');
  });

  it('优先读客户端实际使用的 Latest 端点，url 可达带 3 次重试', () => {
    expect(published).toContain('releases/latest/download/latest.json');
    expect(published).toContain('for ($attempt = 1; $attempt -le 3; $attempt++)');
    expect(published).toContain('-Method Head');
    expect(published).toContain('if (-not $reachable) { throw');
  });

  it('下载公开 url 的真包并校验签名（客户端链路）', () => {
    const gate = step(published, 'Verify public update chain (G1/G4)');
    expect(gate).toContain('Invoke-WebRequest -Uri $url -OutFile $tmp');
    expect(gate).toContain('node src-tauri/verify-sig.mjs');
    expect(gate).toContain('$downloadedSize -ne [int64]$asset.size');
  });

  it('公开链路不通把 Release 打回 draft（Latest 指针随之离开它）', () => {
    const revert = step(published, 'Revert to draft on failure');
    expect(revert).toContain('@{ draft = $true }');
    expect(revert).toContain('-Method Patch');
    expect(revert).toContain('exit 1');
  });
});

describe('verify-sig.mjs：与客户端同一个 minisign 判据', () => {
  it('解析 minisign 公钥/签名记录并比对 keyId', () => {
    expect(verifySig).toContain("Buffer.from(pubkeyBase64.trim(), 'base64')");
    expect(verifySig).toContain('raw.length !== 42');
    expect(verifySig).toContain('raw.length !== 74');
    expect(verifySig).toContain('key id mismatch');
  });

  it('支持预哈希签名（ED = BLAKE2b-512）并做 Ed25519 校验', () => {
    expect(verifySig).toContain("createHash('" + 'blake2b' + "512')");
    expect(verifySig).toContain('edVerify(null, signedBytes, publicKey, sig.signature)');
    expect(verifySig).toContain("alg !== 'Ed' && alg !== 'ED'");
  });
});

describe('P3-1：UpdateInfo 载荷必须是 camelCase', () => {
  it('Rust 侧带 rename_all = camelCase（否则卡片「当前版本」后缀永不渲染）', () => {
    const updater = read('src-tauri/src/updater.rs');
    expect(updater).toMatch(/#\[serde\(rename_all = "camelCase"\)\]\s*\npub struct UpdateInfo/);
    expect(updater).toContain('current_version: String');
  });
});

describe('0.14.11 卡：notes 剥 markdown ＋ 截最近句号（弹窗 textContent 纯文本）', () => {
  it('含 markdown 剥离：反引号／粗体号（标题号由行为判据 (b) 覆盖、不锁源码写法）', () => {
    const compose = step(release, 'Compose latest.json');
    expect(compose).toContain("-replace '`', ''");
    expect(compose).toContain("-replace '\\*\\*'");
  });

  it('截到 500 内最近「。」，<200 退回硬切（负控 #3：先比较后截取、-1 不进 Substring）', () => {
    const compose = step(release, 'Compose latest.json');
    expect(compose).toContain("LastIndexOf('。'");
    expect(compose).toContain('if ($idx -ge 200)');
    expect(compose).toContain('$cut = $idx + 1');
  });

  it('剥后纯空白 ⇒ 回落泛化串（fail-closed 不丢，负控 #2）', () => {
    const compose = step(release, 'Compose latest.json');
    const stripStart = compose.indexOf('if ($notes -ne');
    expect(stripStart, 'strip block not found').toBeGreaterThanOrEqual(0);
    expect(compose.slice(stripStart)).toContain('IsNullOrWhiteSpace($notes)');
  });
});

describe('0.14.11 卡：notes 管线行为判据（与 release.yml 同配方的 JS 内嵌管线）', () => {
  // 同构锁的锚：PIPELINE 的每个字面量同时出现在 release.yml 的 PowerShell（加 (?m) 前缀／-replace 包裹）
  // 和本测试的 JS 复刻（new RegExp 构建）里。产物一动、同构锁红；复刻一动、行为判据红。
  const PIPELINE = {
    heading: '^[ \\t]*#{1,6}[ \\t]*',   // PowerShell 侧为 (?m)^[ \t]*#{1,6}[ \t]*（(?m) 由 /m 标志提供）
    backtick: '`',
    bold: '\\*\\*',
    newlines: '(\\r?\\n){3,}',
    periodCheck: 'if ($idx -ge 200)',
    cutAdjust: '$cut = $idx + 1',
    ellipsis: "+ '…'",
  };

  function stripNotes(body: string): string {
    let s = body;
    s = s.replace(new RegExp(PIPELINE.heading, 'gm'), '');
    s = s.replace(new RegExp(PIPELINE.backtick, 'g'), '');
    s = s.replace(new RegExp(PIPELINE.bold, 'g'), '');
    s = s.replace(new RegExp(PIPELINE.newlines, 'g'), '\n\n');
    s = s.trim();
    if (!s || /^\s*$/.test(s)) return '';
    if (s.length > 500) {
      let cut = 500;
      const code = s.charCodeAt(cut - 1);
      if (code >= 0xD800 && code <= 0xDBFF) cut--;
      const idx = s.lastIndexOf('。', cut - 1);
      if (idx >= 200) cut = idx + 1;
      return s.substring(0, cut) + '…';
    }
    return s;
  }

  // 产物侧字面量清单：与 PIPELINE 无引用关系、独立写死，只用来比对 compose。
  // 作用：红态②只改 PIPELINE ⇒ (b) 红、本锁仍绿——两枚证据各归各的（第 24 枚：判据精确到要证的那层）。
  // 等价表达声明：(?m)（.NET 单行模式前缀）≡ JS /m 标志——锁只咬主体串、不咬语法糖，
  // 否则下次有人为过锁去改产物。PS 单引号串里的 \t 交给 .NET 解释成 TAB，JS 源里的 \\t 同为 TAB，语义同构。
  const ARTIFACT = {
    heading: '(?m)^[ \\t]*#{1,6}[ \\t]*',
    backtick: "-replace '`', ''",
    bold: "-replace '\\*\\*'",
    newlines: "-replace '(\\r?\\n){3,}'",
    periodCheck: 'if ($idx -ge 200)',
    cutAdjust: '$cut = $idx + 1',
    ellipsis: "+ '…'",
  };

  it('同构锁①：ARTIFACT ⊂ compose（锁产物——翻 release.yml 红、翻 PIPELINE 不红）', () => {
    const compose = step(release, 'Compose latest.json');
    expect(compose).toContain(ARTIFACT.heading);
    expect(compose).toContain(ARTIFACT.backtick);
    expect(compose).toContain(ARTIFACT.bold);
    expect(compose).toContain(ARTIFACT.newlines);
    expect(compose).toContain(ARTIFACT.periodCheck);
    expect(compose).toContain(ARTIFACT.cutAdjust);
    expect(compose).toContain(ARTIFACT.ellipsis);
  });

  it('同构锁②：PIPELINE ≡ ARTIFACT（锁副本不漂——只翻 PIPELINE 就红）', () => {
    // 等价表达：ARTIFACT.heading 含 (?m) 前缀（.NET 形态），PIPELINE.heading 是 JS 正则主体（/m 由 flag 提供）——
    // 两者主体串逐字相同；PS 单引号串 \t 与 JS \\t 同为 TAB，语义同构。
    expect(ARTIFACT.heading).toBe(`(?m)${PIPELINE.heading}`);
    expect(ARTIFACT.backtick).toBe(`-replace '${PIPELINE.backtick}', ''`);
    expect(ARTIFACT.bold).toBe(`-replace '${PIPELINE.bold}'`);
    expect(ARTIFACT.newlines).toBe(`-replace '${PIPELINE.newlines}'`);
    expect(ARTIFACT.periodCheck).toBe(PIPELINE.periodCheck);
    expect(ARTIFACT.cutAdjust).toBe(PIPELINE.cutAdjust);
    expect(ARTIFACT.ellipsis).toBe(PIPELINE.ellipsis);
  });

  it('(a) 剥净 markdown 标记：零 #／零反引号／零 **', () => {
    const sample = '### 标题\n\n正文含 `code` 与 **bold** 标记。句号结尾。';
    const out = stripNotes(sample);
    expect(out).not.toMatch(/#/);
    expect(out).not.toMatch(/`/);
    expect(out).not.toMatch(/\*\*/);
  });

  it('(b) 标题前的空行仍在（①机器锁：[ \\t]* 绿、\\s* 红）', () => {
    const sample = '前文。\n\n### 标题\n\n后文。';
    const out = stripNotes(sample);
    // [ \t]* 版：标题行前空行保留 ⇒ 输出含 \n\n标题
    // \s* 版：空行被吃 ⇒ 输出只有 \n标题（红）
    expect(out).toContain('\n\n标题');
  });

  // 分工注（群 PM 15:3x 实测）：(c) 样本里 `###` 直接接在重复段后、不在行首，
  // (?m)^[ \t]*#{1,6}[ \t]* 不匹配它 ⇒ (c) 不走标题剥离路径、(a) 才走——两枚分工不同，
  // 勿以为 (c) 顺带验了剥标题。
  it('(c) 截句分支末两字符＝「。」＋「…」、长度钉 499；硬切分支末字符＝「…」、长度钉 501', () => {
    // 截句分支：正文 >500 且 500 内有「。」≥200（样本固定 ⇒ 长度确定，toBe 比上界强——第 24 枚同族）
    const long = '引言。' + '填充文本。'.repeat(100) + '### 标题\n\n`code` **bold** 末句。';
    const out = stripNotes(long);
    expect(out.length).toBe(499);   // stripped 524 → idx=497 → cut=498 → +…＝499
    expect(out[out.length - 2]).toBe('。');
    expect(out[out.length - 1]).toBe('…');

    // 硬切分支：正文 >500 且 500 内无「。」≥200（'A'.repeat(600) 无代理对 ⇒ 无回退，钉 501）
    const noPeriod = 'A'.repeat(600);
    const hard = stripNotes(noPeriod);
    expect(hard.length).toBe(501);  // 500 + …
    expect(hard[hard.length - 1]).toBe('…');
  });

  it('(c+) 最坏情况：idx 落 499（。恰在 $cut-1 位）⇒ 输出恰 501、末三「a。…」（上限 501 的机器锁）', () => {
    // 上界推导：LastIndexOf('。', $cut-1=499) 可命中 idx=499 → cut=500 → Substring(0,500)+'…'＝501
    // （不是 500：搜索起点就是 499、idx 可达 499）。样本固定 ⇒ toBe 钉死。
    const worst = 'a'.repeat(499) + '。' + 'b'.repeat(120);  // 620 字符，。在 idx=499
    const out = stripNotes(worst);
    expect(out.length).toBe(501);
    expect(out[out.length - 3]).toBe('a');
    expect(out[out.length - 2]).toBe('。');
    expect(out[out.length - 1]).toBe('…');
  });
});

describe('v0.14.12 卡：Release body 从 notes 文件补齐（body_path + 前置断言 + G4-body）', () => {
  it('draft 步 with: 含 body_path 指向 release-notes 文件（正向锁；负控＝删该行必红）', () => {
    const draft = step(release, 'Create draft release');
    expect(draft).toContain('body_path: docs/release-notes-${{ github.ref_name }}.md');
  });

  it('draft 步之前有 notes 文件前置断言：Test-Path + 纯空白 throw（fail-closed，不靠第三方 action）', () => {
    const verify = step(release, 'Verify notes file exists');
    expect(verify).toContain('Test-Path');
    expect(verify).toContain('IsNullOrWhiteSpace');
    expect(verify).toContain('throw');
  });

  it('Verify notes 步的 run: 块零插值（与既有注入锁同判据，新增步也必须合规）', () => {
    const body = step(release, 'Verify notes file exists');
    const runStart = body.indexOf('run: |');
    expect(runStart, 'Verify notes file exists 无 run: 块').toBeGreaterThanOrEqual(0);
    expect(body.slice(runStart), 'Verify notes file exists 的 run: 块内出现 ${{ 插值').not.toContain('${{');
  });

  it('步骤顺序：compose → verify notes → 建 draft → 前置闸（新增步不落位即红）', () => {
    const order = [
      'Compose latest.json',
      'Verify notes file exists',
      'Create draft release',
      'Preflight gate',
    ].map((label) => {
      const i = release.indexOf(`- name: ${label}`);
      expect(i, `missing step: ${label}`).toBeGreaterThanOrEqual(0);
      return i;
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('body 断言落位：draft 侧正向锁（Preflight gate 含 body 非空 throw）＋published 侧反向锁（公开链闸永不因正文空回退）', () => {
    // 正向：body 非空断言在 release.yml 的 Preflight gate——本步失败走 Delete draft on failure，
    // 删的是草稿、公开链不受影响，且在点 Publish 之前就报红（fail-closed 正确落点）。
    const gate = step(release, 'Preflight gate (G1/G2/G5)');
    expect(gate).toContain('IsNullOrWhiteSpace($rel.body)');
    expect(gate).toContain('throw "draft release body is empty');
    // 反向：release-published.yml 不得因 body 空而 throw——该 job 失败会触发 Revert to draft，
    // 把已发布、验签全过的正式版撤下公开口（升级全员中断），与"少一段说明"不成比例。
    expect(published).not.toContain('throw "Release body is empty');
  });

  it('签名 Secrets 前置检查：Verify signing secrets present 步在 Build & sign 之前、点名两枚 env、exit 1（#43 诊断件）', () => {
    // #43（2026-11-08）：Build & sign 跑了 338 秒后报 "failed to decode secret key: …Missing comment in secret key"，
    // 后五步全 skipped、无草稿无资产。本机置空实验证明：candle/light/makensis 全过、Finished 2 bundles 之后才挂，
    // 且 GitHub Actions 里 secret 未配 ⇒ ${{ secrets.X }} 渲染成空串（PS7 $env:X='' 仍"存在且为空"）。
    // ⇒ 该失败用 5 秒前置检查就能拦住，不必等 338 秒+一句看不懂的错。
    const verify = step(release, 'Verify signing secrets present');
    // ① 该步点名两枚 env（判据：谁空就报谁）
    expect(verify).toContain('TAURI_SIGNING_PRIVATE_KEY');
    expect(verify).toContain('TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
    // ② 判据＝任一为空 exit 1（不许吞）
    expect(verify).toContain('exit 1');
    // ③ 只报"哪个变量为空/其长度"，绝不打印值——断言不得出现把值写进输出或日志的模式
    expect(verify).toContain("IsNullOrWhiteSpace($val)");
    // ④ 排序：Verify signing secrets present 必须排在 Build & sign 之前（自报在读数）
    const iVerify = release.indexOf('- name: Verify signing secrets present');
    const iBuild = release.indexOf('- name: Build & sign');
    expect(iVerify, 'Verify signing secrets present 步未找到').toBeGreaterThanOrEqual(0);
    expect(iBuild, 'Build & sign 步未找到').toBeGreaterThanOrEqual(0);
    expect(iVerify).toBeLessThan(iBuild);
    // ⑤ 负控①：Build & sign 之前不得出现 continue-on-error（有 ⇒ 该步红不红无所谓、前置检查形同虚设）
    const beforeBuild = release.slice(0, iBuild);
    expect(beforeBuild, 'Build & sign 之前出现 continue-on-error——签名的红线被绕过').not.toContain('continue-on-error');
    // ⑥ 负控②：Build & sign 之前不得出现 || true（同上）
    expect(beforeBuild, "Build & sign 之前出现 || true——失败被吞、签名空值被发现不了").not.toContain('|| true');
  });
});

describe('v0.14.13 卡 E/F：打包工具预取＋发布正文显式 PATCH（#48）', () => {
  it('卡 E：cache→fetch→assert 三步编排全在 Build & sign 之前、断言看真实文件不看 hit/miss', () => {
    const cache = step(release, 'Restore tauri packaging tools cache');
    expect(cache).toContain('actions/cache@v4');
    expect(cache).toContain('path: C:\\Users\\runneradmin\\AppData\\Local\\tauri');
    expect(cache).toContain('key: tauri-tools-nsis-3.11-wix314');
    const fetch = step(release, 'Fetch missing tauri packaging tools');
    // 两条 URL 字面串（出处见 release.yml 注释）
    expect(fetch).toContain('https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip');
    expect(fetch).toContain('https://github.com/wixtoolset/wix3/releases/download/wix314rtm/wix314-binaries.zip');
    // 重试 3 次＋退避
    expect(fetch).toContain('for ($attempt = 1; $attempt -le 3; $attempt++)');
    expect(fetch).toContain('Start-Sleep');
    // 失败点名哪个 URL（验收要求"失败点名是哪个 URL"）
    expect(fetch).toContain('failed to download');
    const assertStep = step(release, 'Assert packaging tools present');
    expect(assertStep).toContain('makensis.exe');
    expect(assertStep).toContain('candle.exe');
    expect(assertStep).toContain('exit 1');
    // 三步都在 Build & sign 之前（顺序锁）
    const iCache = release.indexOf('- name: Restore tauri packaging tools cache');
    const iFetch = release.indexOf('- name: Fetch missing tauri packaging tools');
    const iAssert = release.indexOf('- name: Assert packaging tools present');
    const iBuild = release.indexOf('- name: Build & sign');
    expect(iCache, 'cache step missing').toBeGreaterThanOrEqual(0);
    expect(iFetch, 'fetch step missing or not after cache').toBeGreaterThan(iCache);
    expect(iAssert, 'assert step missing or not after fetch').toBeGreaterThan(iFetch);
    expect(iBuild, 'Build & sign must come after assert').toBeGreaterThan(iAssert);
  });

  it('卡 F：draft 之后有显式 PATCH body 步（charset=utf-8＋回读等值三件套＋零插值）', () => {
    // 注：step() 用 indexOf 子串匹配，步名只锁存在性、不锁唯一性（将来新增同名前缀步仍绿）；
    // 真判据在下面的内容断言（-Method Patch／charset／per_page／firstDiff），不靠步名。
    const patch = step(release, 'Patch draft release body');
    expect(patch).toContain('-Method Patch');
    expect(patch).toContain("-ContentType 'application/json; charset=utf-8'");
    // 查草稿走全量列表（与 Preflight gate 同坑），不许回退到 tags 端点
    expect(patch).toContain('/releases?per_page=100');
    expect(patch).toContain("$_.tag_name -eq $tag -and $_.draft");
    expect(patch).not.toContain('$repo/releases/tags/');
    // 回读等值三件套：两枚长度＋firstDiff 显式循环＋<end>
    expect(patch).toContain('expected_len=');
    expect(patch).toContain('actual_len=');
    expect(patch).toContain('firstDiff=');
    expect(patch).toContain('<end>');
    expect(patch).toContain('throw "draft release body != notes file after PATCH"');
    // run: 块零插值（与既有注入锁同判据，新增步也必须合规）
    const runStart = patch.indexOf('run: |');
    expect(runStart, 'patch 无 run: 块').toBeGreaterThanOrEqual(0);
    expect(patch.slice(runStart), 'patch run: 块内出现 ${{ 插值').not.toContain('${{');
    // 位置：Create draft release < Patch < Preflight gate
    const iDraft = release.indexOf('- name: Create draft release');
    const iPatch = release.indexOf('- name: Patch draft release body');
    const iGate = release.indexOf('- name: Preflight gate');
    expect(iPatch, 'patch must come after draft').toBeGreaterThan(iDraft);
    expect(iGate, 'gate must come after patch').toBeGreaterThan(iPatch);
  });

  it('卡 F：Preflight gate 非空断言保留＋等值断言新增（旧正向锁一条不许消失）', () => {
    const gate = step(release, 'Preflight gate (G1/G2/G5)');
    // 旧正向锁（L350-351 那对）——纪律④"只加不改删"
    expect(gate).toContain('IsNullOrWhiteSpace($rel.body)');
    expect(gate).toContain('throw "draft release body is empty');
    // 新增等值断言（三件套同判据）
    expect(gate).toContain('throw "draft release body != notes file (preflight equality check)"');
    expect(gate).toContain('$notesExpected');
    expect(gate).toContain('$bodyActual');
  });
});

describe('CI-H（#50）：cargo-check job 前置产物步骤锁', () => {
  // ci.yml 目前不被任何测试或 gate 步骤锁形状（tools/gate/run.ts:L12 与 acl-contract-guard.ts:L157
  // 的命中都是注释文字、非断言）。这里用字符串定位锁住 cargo-check job 的四枚前置产物步骤，
  // 不锁整行表达式、不锁全文件步数——判据＝四枚短标识符在 cargo-check job 段内存在。
  const ci = read('.github/workflows/ci.yml');

  it('cargo-check job 含 setup-node→npm ci→npm run build→fetch-node 四步前置（CI-H 根因：tauri-build 无条件 copy_resources 缺 gitignored 产物即 Err）', () => {
    // 取 cargo-check job 段（从 "cargo-check:" 到文件尾）
    const start = ci.indexOf('cargo-check:');
    expect(start, 'cargo-check job not found').toBeGreaterThanOrEqual(0);
    const jobBody = ci.slice(start);
    // 四枚前置产物步骤的短标识符（不锁整行、不锁顺序——顺序由 YAML 缩进保证、由 push 远程验）
    expect(jobBody).toContain('setup-node');
    expect(jobBody).toContain('npm ci');
    expect(jobBody).toContain('npm run build');
    expect(jobBody).toContain('fetch-node.mjs');
    // cargo check 本体仍在
    expect(jobBody).toContain('cargo check --tests');
  });
});
