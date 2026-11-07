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
