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

  it('优先读客户端实际使用的 Latest 端点，url 可达带重试（上限≥3）', () => {
    expect(published).toContain('releases/latest/download/latest.json');
    // #59：原 `toContain('for ($attempt = 1; $attempt -le 3; $attempt++)')` 把"恰好 3 次"锁死，
    // 实现改次数就红（同族缺陷，与卡 E 的 L395 一起改）。改为锁性质：上限 ≥3、退化成 1–2 次显式红、
    // 有睡眠退避、可达后 break。（标题随断言同步改，原标题「…带 3 次重试」留档在台账。）
    // 我抓不住：睡眠秒数被改小（release-published.yml 现值 Start-Sleep -Seconds 10 未锁死）；
    //           上限被改成 4–9（仍在 [3-9] 内、且不属于"退化"，属可接受区间外的钝角）。
    expect(published, '发布后公开链路的可达重试循环丢失或被改成 <3 次').toMatch(/\$attempt\s*-\le\s*[3-9]\b/);
    expect(published, '发布后公开链路的重试上限退化为 1–2 次（等于不重试）').not.toMatch(/\$attempt\s*-\le\s*\$?[12]\b/);
    expect(published, '发布后公开链路的重试已无睡眠退避').toContain('Start-Sleep -Seconds');
    expect(published, '公网 HEAD 可达后的 break 丢失（会白跑满次数）').toContain('$reachable = $true; break');
    expect(published).toContain('-Method Head');
    // 旧锁 `if (-not $reachable) { throw` 的行已被第 107 件改成多行形态（::error:: 注解在 throw 前），
    // 等强替换为两段：fail-closed throw 本体＋九格注解锁（missingPubDiags）另盖注解面。
    expect(published, '发布后公开链路可达性 fail-closed throw 丢失').toContain('if (-not $reachable) {');
    expect(published, '发布后公开链路可达性 fail-closed throw 文案丢失').toContain('throw "public download url not reachable after 3 attempts');
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
    // ── step 9 重试编排性质锁（#59：原「字面钉死 3 次」已删，改为锁性质） ──
    // 背景：$maxAttempts 由 3 改 5 时，旧断言 `toContain('for ($attempt = 1; $attempt -le 3; ...)')`
    // 直接把实现锁死，实现一变就红（#58 闸红即此因）。下面 14 枚锁的是"有重试、退避按序、
    // 分类不倒、阈值取实测、解压与睡眠都在循环内"这些性质——实现改数字仍绿，性质被破坏才红。
    //
    // 我抓不住哪一类变异（判据 5 尾巴）：
    //   ① Expand-Archive 的 -Force 被删（覆盖已解压目录的能力丢失）——需真 runner 行为验证，#59 候选；
    //   ② 真实等待是否真的发生（本文件只验"算得对"，"等得住"由真发版 run 作证，#58 后批残格）；
    //   ③ 退避总上限与注释 150s 是否联动（四个值不变而注释改大仍绿）。
    const attemptFor = fetch.indexOf('for ($attempt');
    const notOkIdx = fetch.indexOf('if (-not $ok)');
    const expandIdx = fetch.indexOf('Expand-Archive');
    const sleepIdx = fetch.indexOf('Start-Sleep');
    // a) 尝试上限＝5（退化成更低次数会让下面 k/l 与上限断言同时失配）
    expect(fetch, '尝试上限 $maxAttempts = 5 缺失或被改').toContain('$maxAttempts = 5');
    // b) 指数退避序列
    expect(fetch, '退避序列 $backoffSecs = @(10, 20, 40, 80) 被改').toContain('$backoffSecs = @(10, 20, 40, 80)');
    // c) 可重试分类：整条 return 表达式锁死（方向被翻、条件被删都红）
    expect(fetch, 'Test-Retryable 的 return 表达式被改（-ge 500 / -eq 429）')
      .toMatch(/return \(\$code -ge 500\) -or \(\$code -eq 429\)/);
    // e) "可重试才重试"的否定判断被去掉 ⇒ 重试逻辑整个反过来
    expect(fetch, 'if ($code -and -not (Test-Retryable $code)) 被改：不可重试的错误会被重试')
      .toContain('if ($code -and -not (Test-Retryable $code))');
    // f) 两枚阈值取实测值，并各自落在对应工具那一行（互换即红）
    const nsisLine = fetch.split('\n').find((l) => l.includes("name='NSIS'")) ?? '';
    const wixLine = fetch.split('\n').find((l) => l.includes("name='WiX'")) ?? '';
    expect(nsisLine, 'NSIS 的 minBytes=1500000 缺失或与 WiX 互换').toContain('minBytes=1500000');
    expect(wixLine, 'WiX 的 minBytes=30000000 缺失或与 NSIS 互换').toContain('minBytes=30000000');
    // g) 解压在 attempt 循环内（下界＝循环起点，上界＝循环后的 if (-not $ok)）
    expect(attemptFor, 'fetch 步里找不到 for ($attempt 循环').toBeGreaterThanOrEqual(0);
    expect(notOkIdx, 'fetch 步里找不到循环后的 if (-not $ok)').toBeGreaterThan(attemptFor);
    expect(expandIdx, 'Expand-Archive 必须出现在 attempt 循环内（循环起点之后）').toBeGreaterThan(attemptFor);
    expect(expandIdx, 'Expand-Archive 被挪到 attempt 循环之外（解压失败将不走同一条退避）').toBeLessThan(notOkIdx);
    // h) 只有解压成功才置 $ok 并 break
    expect(fetch, '$ok = $true 与 break 缺失（成功判定被改）').toMatch(/\$ok = \$true\s*\n\s*break/);
    // i) 注释里的实测值与取样日期（阈值来历可追溯）
    expect(fetch, '注释实测值 2,361,546 缺失').toContain('2,361,546');
    expect(fetch, '注释实测值 41,282,726 缺失').toContain('41,282,726');
    expect(fetch, '注释取样日期 2026-11-10 缺失').toContain('2026-11-10');
    // j) 只有一处 attempt 循环与一处 after-loop 判定（不许并存两套重试逻辑）
    expect(fetch.match(/for \(\$attempt/g)?.length ?? 0, '出现多处 attempt 循环').toBe(1);
    expect(fetch.match(/if \(\$attempt -lt \$maxAttempts\)/g)?.length ?? 0, '出现多处退避判断').toBe(1);
    // k) 退避秒数按下标取（写成 $backoffSecs[0] 会让退避永远 10s）
    expect(fetch, '退避秒数未按 $attempt - 1 取下标').toContain('$wait = $backoffSecs[$attempt - 1]');
    // l) 睡眠用的是算出来的 $wait（写死秒数＝退避序列名存实亡）
    expect(fetch, 'Start-Sleep 没有使用算出的 $wait').toContain('Start-Sleep -Seconds $wait');
    // m) 睡眠也在 attempt 循环内（挪出循环＝指数退避形同虚设）
    expect(sleepIdx, 'Start-Sleep 必须出现在 attempt 循环内（循环起点之后）').toBeGreaterThan(attemptFor);
    expect(sleepIdx, 'Start-Sleep 被挪到 attempt 循环之外').toBeLessThan(notOkIdx);
    expect(fetch).toContain('Start-Sleep');
    // ── R-1（2026-11-10）解压落点/marker 映射锁：本次发版链真死因 ──
    // 现场：run 42724494390 step 9 末行 `NSIS archive extracted but marker still missing:
    //   …\tauri\NSIS\Bin\makensis.exe`。根因＝zip 顶层目录名（nsis-3.11/）≠ marker 父目录名（NSIS/），
    //   旧写法 `Expand-Archive -DestinationPath $t.dest` 把包原样解到 $tauri 下 ⇒ marker 永不可能命中；
    //   这个坏分支**从未被执行过**（缓存命中时 step 8 已放好工具），所以闸绿了一整天也照不出来。
    // 断言锁"映射关系"而非目录名：换包版本（nsis-3.12/）或换工具，只要映射还对就仍绿。
    //
    // 我抓不住哪一类变异（判据 5 尾巴）：
    //   ① 深度上限 2 层改成 3 层（本文件不看循环上界常量，只锁"逐层收敛"的形态）；
    //   ② 真实布局匹配是否真的发生（本文件只验脚本文本形状，真跑要真 runner／真包）；
    //   ③ `-Depth` 类参数被换成等价的显式两层遍历（写法变了但语义相同，本不该红）。
    const relDeclIdx = fetch.indexOf('$rel = $t.marker.Substring(');
    const lookIdx = fetch.indexOf('Test-Path (Join-Path $_ $rel)');
    const moveIdx = fetch.indexOf('Move-Item -Destination $dstParent');
    const expandDeclIdx = fetch.indexOf('Expand-Archive -Path $zip -DestinationPath $tmpExtract');
    const dstParentDeclIdx = fetch.indexOf('$dstParent = Split-Path $t.marker -Parent');
    // n) 解压落点必须是临时区变量，不得直接落 $t.dest / $tauri（R-1 的原始死因）
    expect(expandDeclIdx, 'R-1：Expand-Archive 未解压到临时区变量 $tmpExtract（可能又直接落到 marker 父目录）')
      .toBeGreaterThanOrEqual(0);
    expect(fetch, 'R-1：解压落点又回到 $t.dest（当初的路径错配死因）').not.toContain('Expand-Archive -Path $zip -DestinationPath $t.dest');
    // o) marker 尾相对路径参与推导：$rel 由 marker 减父目录得出
    expect(relDeclIdx, 'R-1：$rel 未由 $t.marker.Substring($dstParent.Length + 1) 推导（marker 尾相对路径未参与）')
      .toBeGreaterThanOrEqual(0);
    expect(dstParentDeclIdx, 'R-1：$dstParent 未由 Split-Path $t.marker -Parent 得出')
      .toBeGreaterThanOrEqual(0);
    // p) 定位用同一枚 $rel（不是另写死的目录名）
    expect(lookIdx, 'R-1：定位层未使用 (Join-Path $_ $rel) —— 可能有写死的目录名')
      .toBeGreaterThanOrEqual(0);
    // q) 存在一次把临时区某层内容搬到 marker 父目录的动作
    expect(moveIdx, 'R-1：缺少 Move-Item -Destination $dstParent —— 定位到了却没有搬运')
      .toBeGreaterThanOrEqual(0);
    // r) 三处同源：推导 → 定位 → 搬运，用的都是 $rel／$dstParent 这一对，不许各写各的
    expect(relDeclIdx, 'R-1：$rel 推导必须在定位之前').toBeLessThan(lookIdx);
    expect(lookIdx, 'R-1：定位必须在搬运之前').toBeLessThan(moveIdx);
    // s) 解压/定位/搬运仍都在 attempt 循环内（失败照走重试，不靠重跑整个 job）
    expect(expandDeclIdx, 'R-1：解压被挪出 attempt 循环').toBeGreaterThan(attemptFor);
    expect(expandDeclIdx, 'R-1：解压跑到循环之后去了').toBeLessThan(notOkIdx);
    expect(moveIdx, 'R-1：搬运被挪出 attempt 循环').toBeGreaterThan(attemptFor);
    expect(moveIdx, 'R-1：搬运跑到循环之后去了').toBeLessThan(notOkIdx);
    // t) marker 硬校验仍在搬运之后（搬完必须立刻验，验不过就 throw 走重试）
    expect(fetch.indexOf('archive relocated but marker still missing'), 'R-1：搬运后没有 marker 复核（搬错也会被当成功）')
      .toBeGreaterThan(moveIdx);
    // 失败点名哪个 URL（验收要求"失败点名是哪个 URL"）
    expect(fetch).toContain('failed to download');
    // u) 判据 D：三类失败文案必须共存且互不相同（歧义／未命中／搬运后仍缺 marker）。
    // 只锁"三者存在且不同"，不锁整句——措辞润色不该红，但把 ambiguous 与 unmatched 合并成一句
    // 通用报错必须红：那正是这次把 504 当根因的那种失效（两病同症状、日志分不出）。
    const throwStrs = ['ambiguous layout', 'layout unmatched', 'archive relocated but marker still missing'];
    for (const s of throwStrs) {
      expect(fetch, `R-1 判据 D：缺少失败文案「${s}」`).toContain(s);
    }
    expect(new Set(throwStrs).size, 'R-1 判据 D：三条文案必须互不相同').toBe(3);
    // v) R-2 追加（2026-11-10）：确定性布局类失败不重试、最终报错保留真因
    // （负控＝删 ②或③任一行 ⇒ 必红，防有人把整段退化成"全重试＋模板报错"）
    //   v-② 布局错误走 throw、不走退避（重试 5 次只是白等 150s 并把真因盖成下载失败）
    expect(fetch, 'R-2：$isLayoutError 判定缺失（布局类确定性失败会被误重试 5 次并按下载故障上报）')
      .toContain('$isLayoutError');
    expect(fetch, 'R-2：布局错误必须直接 throw 且文案含 not retried（不进退避循环）')
      .toContain('deterministic failure (not retried)');
    //   v-③ 末条 throw 必须带真实错误串（不带则真因被模板盖掉）
    expect(fetch, 'R-2：末条 throw 缺 last error: —— 真因会被通用模板盖掉').toContain('last error:');
    //   v-④ 前缀↔判定式同源锁（PM ②：防止有人删 throw 里的 [LAYOUT] 而判定式仍在、分类静默失效）
    // 判据是对**正则源串**取的：workflow 里写的是 -match '^\[LAYOUT\]'（方括号在正则里需转义），
    // 所以这里断言 `^\[LAYOUT\]`（JS 字符串里写作 "\\[" 表示一个反斜杠），不是 `^[LAYOUT]`。
    expect(fetch, "R-2：判定式缺 '^\\[LAYOUT\\]' 串（isLayoutError 的匹配来源）").toContain('^\\[LAYOUT\\]');
    const layoutCount = (fetch.match(/\[LAYOUT\]/g) ?? []).length;
    expect(layoutCount, `R-2：[LAYOUT] 前缀应出现 ≥3 次（三条布局 throw 各一枚），实际 ${layoutCount}`)
      .toBeGreaterThanOrEqual(3);
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
    expect(patch).toContain('throw "draft release body != notes file after PATCH');
    // v5 补：锁 by-id 回读路径存在（主路径改走 GET /releases/{id}，列表端点仅回退）
    expect(patch).toContain('/releases/$($rel.id)"');
    // v5 补：锁 ::error:: 诊断前缀（匿名可读通道，下一发再红时真因直接可读）
    expect(patch).toContain('::error::[patch-body] body mismatch:');
    // run: 块零插值（与既有注入锁同判据，新增步也必须合规）
    // PM ④ 裁口径：脚本体内只允许 ${{ steps.<id>.outputs.<name> }}（action 输出取值＝数据通道），
    // 其余任何 ${{ }} 形态一律判红（含 github.token/env.X/表达式/函数调用）。
    // 旧版"排除 env 段"是假绿：indexOf('env:') 命中脚本体内的 $env:TAG_NAME，把 5736 字节截成 67 字节。
    // PM ②③ 要求：剥注释再查（甲案），防注释里的 ${{ }} 举例误红。
    const runStart = patch.indexOf('run: |');
    expect(runStart, 'patch 无 run: 块').toBeGreaterThanOrEqual(0);
    const runBody = patch.slice(runStart);
    // 剥注释：逐行去掉行内 # 之后的内容（PowerShell 注释语法），再扫插值
    const runNoComments = runBody.split('\n').map(l => {
      const hashIdx = l.indexOf('#');
      // 只剥行内注释（# 前有空格或行首 #），不剥字符串内的 #
      if (hashIdx >= 0 && (hashIdx === 0 || /\s/.test(l[hashIdx - 1]))) {
        return l.substring(0, hashIdx);
      }
      return l;
    }).join('\n');
    // 检 run: 脚本体全量（剥注释后），只放行 steps.<id>.outputs.<name> 形态
    const allExprs = runNoComments.match(/\$\{\{[^}]+\}\}/g) ?? [];
    // 第 G-d 件：过滤类断言须证"被检查对象非空"（判据：allExprs 空 ⇒ illegalExprs 必空 ⇒ 锁空跑假绿）
    expect(allExprs.length, 'patch run: 体无任何 ${{ }} 插值——注入锁空跑（被检查对象为空）').toBeGreaterThan(0);
    const illegalExprs = allExprs.filter(e => !/\$\{\{\s*steps\.\w+\.(outputs|result)\.\w+\s*\}\}/.test(e));
    expect(illegalExprs, `patch run: 脚本体内出现非法 ${{ }} 插值（只允许 steps.<id>.outputs.<name> 数据通道）：${illegalExprs.join('; ')}`).toHaveLength(0);
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

  // v0.14.16 run 真因（第 89 件同族重演）：step17 草稿查找只走列表端点、一次查询、无重试、无现场数据；
  // 列表首查未命中 ⇒ "[preflight-gate] draft release for tag v0.14.16 not found"（为何未命中未证实——现场三件注解即为此设）。
  // 修＝与 Patch 步同一套确定性形态：RELEASE_ID 走 env 数据通道（run 体零插值锁 L61 不破）
  // → GET /releases/{id} by-id 优先 → 列表仅回退 → 3 次带退避。
  const gateByIdFirst = (gate: string): boolean => {
    const byIdIdx = gate.indexOf('/releases/$draftId');
    const listIdx = gate.indexOf('/releases?per_page=100');
    return byIdIdx >= 0 && listIdx >= 0 && byIdIdx < listIdx;
  };

  it('卡 F：Preflight gate 草稿查找 by-id 优先（RELEASE_ID env 数据通道→GET /releases/{id}，列表仅回退、3 次退避、现场三件进注解）＋Delete draft 同族 by-id', () => {
    const gate = step(release, 'Preflight gate (G1/G2/G5)');
    // ① id 来源＝env 数据通道（env 段在 run: 之前、不在零插值被检面内）
    expect(gate).toContain('RELEASE_ID: ${{ steps.create_release.outputs.id }}');
    expect(gate).toContain('$draftId = $env:RELEASE_ID');
    // ② 顺序锁：by-id 直查先于列表回退（防静默退回列表端点）
    expect(gateByIdFirst(gate), 'Preflight gate 未走 by-id 优先（by-id 查询缺失或晚于列表回退）').toBe(true);
    // ③ 首查重试（3 次带退避）＋查不到 ::error:: 注解
    expect(gate).toContain('find attempt');
    expect(gate).toContain('::error::[preflight-gate] draft release for tag');
    // ④ 现场三件进注解（列表返回条数／draft 条数／首条 id+tag）——"没找到"之外必须有现场
    expect(gate).toContain('list diagnostic: returned=$listCount drafts=$listDraftCount first=$listFirst');
    // ⑤ run: 体零插值不破（与 L61 注入回归锁同判据，双保险）
    const runStart = gate.indexOf('run: |');
    expect(runStart, 'gate 无 run: 块').toBeGreaterThanOrEqual(0);
    expect(gate.slice(runStart)).not.toContain('${{');
    // ⑥ 同族：Delete draft on failure 同样 by-id 优先（清理步漏删＝draft 泄漏）；列表端点保留为回退
    const cleanup = step(release, 'Delete draft on failure (fail-closed)');
    expect(cleanup).toContain('RELEASE_ID: ${{ steps.create_release.outputs.id }}');
    expect(cleanup).toContain('/releases/$draftId');
    expect(cleanup).toContain('/releases?per_page=100');
    // ⑦ 绝不删已发布的构造保证不许丢：by-id 取回后仍须核 draft 才删
    expect(cleanup).toContain('-not $rel.draft');
  });

  it('负控：把 Preflight gate 的 by-id 查询摘掉 ⇒ by-id 顺序判定必红（判据有判别力）', () => {
    const gate = step(release, 'Preflight gate (G1/G2/G5)');
    // 变异：抹掉 by-id 查询串（模拟退回纯列表端点——v0.14.16 step17 死法）
    const mutated = gate.replace('/releases/$draftId', '/releases/REMOVED-BY-ID');
    expect(gateByIdFirst(mutated), '负控失效：摘掉 by-id 后顺序判定仍通过 ⇒ 判据无判别力').toBe(false);
  });
});

describe('第 107/108/110 件：发布后闸可观测性＋草稿 target 钉 tag 提交＋清理步 fail-loud（20261111 pub-chain 自撤事件）', () => {
  const pubGate = step(published, 'Verify public update chain (G1/G4)');
  const revert = step(published, 'Revert to draft on failure');
  // 判据函数：九格失败分支 ::error:: 全在＋诊断行（tag_name/ref_name 双打）＋红前 draft 状态（含 body_len）⇒ 空=合格
  const missingPubDiags = (body: string): string[] => {
    const markers = [
      '[pub-chain] diag: repo=$repo tag_name=$tag ref_name=$env:REF_NAME',
      '::error::[pub-chain] tag-asset latest.json fetch failed',
      '::error::[pub-chain] manifest version mismatch',
      '::error::[pub-chain] manifest missing url/signature',
      '::error::[pub-chain] releases/{id} fetch failed',
      '::notice::[pub-chain] release context: id=$env:RELEASE_ID',
      '$rawVersion = $env:RELEASE_NAME',
      'git_ref_tags/$tag=$gitRefState',
      'tag_name=$($rel.tag_name)',
      '::error::[pub-chain] release not bound to git tag:',
      '::error::[pub-chain] manifest url asset not in release',
      '::error::[pub-chain] manifest url asset name contains a space',
      '::error::[pub-chain] public download url not reachable',
      '::error::[pub-chain] downloaded size mismatch',
      '::error::[pub-chain] signature verification failed',
      'release state: draft=$($rel.draft)',
      'body_len=$($rel.body.Length)',
    ];
    return markers.filter(m => !body.includes(m));
  };
  // 撤回步可观测判据（第 107 件）：PATCH 前/失败/后三处 ::error:: 全在
  const missingRevertDiags = (body: string): string[] => {
    const markers = [
      '::error::[revert-to-draft] reverting: tag=$tag id=$($rel.id) draft_before=',
      '::error::[revert-to-draft] PATCH draft=true failed',
      '::error::[revert-to-draft] reverted: tag=$tag id=$($rel.id) draft_after=',
    ];
    return markers.filter(m => !body.includes(m));
  };
  const hasTargetPin = (body: string): boolean => body.includes('target_commitish: ${{ github.sha }}');
  const hasFailLoud = (body: string): boolean =>
    body.includes('::error::[delete-draft] fail-closed branch entered but no draft found') &&
    body.includes('throw "no draft release found for $tag in fail-closed branch') &&
    body.includes('::error::[delete-draft] release $($rel.id) for $tag is not a draft') &&
    body.includes('if ($rel -and -not $rel.draft)');

  it('第 107 件：step4 九格 throw 点前打 ::error:: 现场（tag_name/ref_name/HTTP/version/资产名/body_len）＋红前打 draft 状态（注解匿名可读，下一发红不用日志正文定字）', () => {
    const missing = missingPubDiags(pubGate);
    expect(missing, `发布后闸诊断缺失：${missing.join('; ')}`).toHaveLength(0);
  });

  it('第 107 件：step5 撤回动作自身可观测——PATCH 前/失败/后三处 ::error::（分清"撤回了/没撤成"）', () => {
    const missing = missingRevertDiags(revert);
    expect(missing, `撤回步诊断缺失：${missing.join('; ')}`).toHaveLength(0);
  });

  it('负控：抹掉任一枚 ::error:: 标记 ⇒ 诊断锁必红（判据有判别力）', () => {
    const mutated = pubGate.replace('::error::[pub-chain] manifest version mismatch', '::error::[REMOVED]');
    expect(mutated).not.toBe(pubGate);
    expect(missingPubDiags(mutated).length, '负控失效：抹掉诊断标记后判据仍通过 ⇒ 锁无判别力').toBeGreaterThan(0);
    const mutatedRevert = revert.replace('::error::[revert-to-draft] reverted:', '::error::[REMOVED]');
    expect(mutatedRevert).not.toBe(revert);
    expect(missingRevertDiags(mutatedRevert).length, '负控失效：抹掉撤回标记后判据仍通过 ⇒ 锁无判别力').toBeGreaterThan(0);
  });

  it('第 110 件：step15 建草稿显式钉 target＝tag 提交（不许继承分支名——两发 head_sha=master 尖端即此坑）', () => {
    const draftStep = step(release, 'Create draft release');
    expect(hasTargetPin(draftStep), 'step15 缺 target_commitish 钉 tag 提交').toBe(true);
    // 负控：抹掉 target 行 ⇒ 同一判据必红
    const mutated = draftStep.replace('          target_commitish: ${{ github.sha }}\n', '');
    expect(mutated).not.toBe(draftStep);
    expect(hasTargetPin(mutated), '负控失效：抹掉 target 后判据仍通过 ⇒ 锁无判别力').toBe(false);
  });

  it('第 108 件：step18 清理步 fail-loud——查不到目标/目标非 draft 必须 ::error::＋throw，不许静默 exit 0（v0.14.16 draft 存活至 13:38 即此坑）', () => {
    const cleanup = step(release, 'Delete draft on failure (fail-closed)');
    expect(hasFailLoud(cleanup), 'step18 清理步缺 fail-loud（::error::＋throw）或丢「绝不删已发布」守卫').toBe(true);
    // 负控：把 throw 退回静默 exit 0 ⇒ 同一判据必红
    const mutated = cleanup.replace('throw "no draft release found for $tag in fail-closed branch', 'exit 0 #');
    expect(mutated).not.toBe(cleanup);
    expect(hasFailLoud(mutated), '负控失效：退回静默通过后判据仍绿 ⇒ 锁无判别力').toBe(false);
  });

  it('第 110 件验证面：step4 步首 ::notice:: 打 github.ref＋github.sha＋target_commitish（匿名可读注解，一发定案"闸读 tag 提交还是分支尖端"）', () => {
    const hasCommitish = (body: string): boolean =>
      body.includes('GH_REF: ${{ github.ref }}') &&
      body.includes('GH_SHA: ${{ github.sha }}') &&
      body.includes('TARGET_COMMITISH: ${{ github.event.release.target_commitish }}') &&
      body.includes('::notice::[pub-chain] commitish:') &&
      body.includes('github.sha=$env:GH_SHA') &&
      body.includes('target_commitish=$env:TARGET_COMMITISH');
    expect(hasCommitish(pubGate), 'step4 缺 commitish 三件 ::notice::（第 110 件待验推论的验证面）').toBe(true);
    // 负控：抹掉 github.sha 两处 ⇒ 同一判据必红
    const mutated = pubGate.replace('GH_SHA: ${{ github.sha }}', 'GH_SHA: ${{ REMOVED }}')
      .replace('github.sha=$env:GH_SHA', 'github.sha=$env:REMOVED');
    expect(mutated).not.toBe(pubGate);
    expect(hasCommitish(mutated), '负控失效：抹掉 github.sha 后判据仍绿 ⇒ 锁无判别力').toBe(false);
  });

  it('G-f（第 112 件）：release 取数走 id 数据通道＋版本号从 release.name 推＋git 标签绑定三方并排＋发布后断言 tag_name==期望（unbound release 的 tag_name 是合成名）', () => {
    const hasByIdAndNameVersion = (body: string): boolean =>
      body.includes('RELEASE_ID: ${{ github.event.release.id }}') &&
      body.includes('/releases/$env:RELEASE_ID') &&
      body.includes('::notice::[pub-chain] release context: id=$env:RELEASE_ID') &&
      body.includes('$rawVersion = $env:RELEASE_NAME') &&
      body.includes('git_ref_tags/$tag=$gitRefState') &&
      body.includes('::error::[pub-chain] release not bound to git tag:') &&
      body.includes('$rel.html_url -notlike');
    expect(hasByIdAndNameVersion(pubGate), 'step4 缺 release.id 数据通道或版本号仍依赖 tag_name').toBe(true);
    // 负控：把 by-id 退回按 tag 查＋版本号改回 $tag ⇒ 同一判据必红
    const mutated = pubGate.replaceAll('/releases/$env:RELEASE_ID', '/releases/tags/$tag')
      .replace('$rawVersion = $env:RELEASE_NAME', '$rawVersion = $tag');
    expect(mutated).not.toBe(pubGate);
    expect(hasByIdAndNameVersion(mutated), '负控失效：退回按 tag 查/按 tag 推版本后判据仍绿 ⇒ 锁无判别力').toBe(false);
  });
});

describe('G-e：发布链 runner 侧取数工具统一（不出现裸 curl）', () => {
  it('.github/workflows/*.yml 内不出现裸 curl（runner 侧统一 Invoke-RestMethod／Invoke-WebRequest）', () => {
    for (const w of ['.github/workflows/release.yml', '.github/workflows/release-published.yml', '.github/workflows/ci.yml']) {
      expect(read(w), `${w} 含裸 curl（runner 侧 curl／Invoke-WebRequest 混用是隐患）`).not.toMatch(/\bcurl\b/);
    }
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

describe('卡 F 注入锁负控：steps.<id>.outputs.<name> 放行绿、github.token 判红（PM ②③ 仓内真负控）', () => {
  const patch = step(release, 'Patch draft release body');
  const runStart = patch.indexOf('run: |');
  expect(runStart, 'patch 无 run: 块').toBeGreaterThanOrEqual(0);
  const runBody = patch.slice(runStart);
  // 剥注释（与主断言同法）
  const runNoComments = runBody.split('\n').map(l => {
    const h = l.indexOf('#');
    if (h >= 0 && (h === 0 || /\s/.test(l[h - 1]))) return l.substring(0, h);
    return l;
  }).join('\n');
  // allowlist（与主断言同判据）
  const allowlist = (body: string) => {
    const exprs = body.match(/\$\{\{[^}]+\}\}/g) ?? [];
    return exprs.filter(e => !/\$\{\{\s*steps\.\w+\.(outputs|result)\.\w+\s*\}\}/.test(e));
  };

  it('正控：steps.create_release.outputs.id 是合法数据通道 ⇒ illegalExprs 为空', () => {
    expect(allowlist(runNoComments), `正控：合法 steps.*.outputs.* 应放行`).toHaveLength(0);
  });

  it('负控：变异成 github.token ⇒ 必须红（illegalExprs 非空且含 github.token）', () => {
    const mutated = runNoComments.replace(
      /\$\{\{\s*steps\.create_release\.outputs\.id\s*\}\}/g,
      '${{ github.token }}'
    );
    const illegal = allowlist(mutated);
    expect(illegal.length, `负控：变异成 github.token 后必须被判非法（实际 ${illegal.length} 处）`).toBeGreaterThan(0);
    expect(illegal.some(e => e.includes('github.token')), '负控：变异后的非法表达式必须含 github.token').toBe(true);
  });
});
