#!/usr/bin/env node
// 发版前置闸 G2：**用最终安装包字节** 校验 latest.json 里的 signature 与 tauri.conf.json 的 pubkey 是否配对。
//
// 为什么需要它：
//   - P1-2（url 死链）修好后，下载能落到真包上；客户端随后会做
//     `verify_signature(&buffer=下载到的字节, &latest.json.signature, &config.pubkey, ...)`
//     （tauri-plugin-updater-2.13.3/src/updater.rs:837-843）。
//     若 GitHub Secret 里的签名私钥与仓库 pubkey 不是一对（换过密钥、Secret 串错），
//     每个用户都会在「立即更新」下载完成后失败，而发版流水线看起来是绿的 —— 这就是本闸要拦的。
//   - **签名的对象是安装包字节，不是 latest.json**（同上 837-843 行）：所以改 url/notes 不需要重签，
//     但**上传的资产字节**必须与 signature 配对。上一版流程缺的正是这一条校验。
//   - `tauri-cli 2.12.1` 没有 `signer verify` 子命令（只有 sign / generate，见 `npx tauri signer --help`），
//     所以这里用 Node 内置 crypto 按 minisign 格式直接校验，零新增依赖、不联网、不碰私钥。
//
// 用法：
//   node src-tauri/verify-sig.mjs --pubkey <base64> --signature <base64> --file <安装包路径>
//   （--signature 也可给 .sig 文件路径：--signature-file <path>）
//
// 退出码：0 = 配对；1 = 不配对/格式错误（fail-closed，发版流水线据此中止并删 draft）。

import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function die(msg) {
  console.error(`[verify-sig] FAIL: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { pubkey: null, signature: null, signatureFile: null, file: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) die(`missing value for ${a}`);
      i += 1;
      return v;
    };
    if (a === '--pubkey') args.pubkey = next();
    else if (a === '--signature') args.signature = next();
    else if (a === '--signature-file') args.signatureFile = next();
    else if (a === '--file') args.file = next();
    else if (a === '-h' || a === '--help') {
      console.log('usage: node verify-sig.mjs --pubkey <b64> (--signature <b64>|--signature-file <path>) --file <path>');
      process.exit(0);
    } else die(`unknown argument: ${a}`);
  }
  if (!args.pubkey) die('--pubkey is required');
  if (!args.file) die('--file is required');
  if (!args.signature && !args.signatureFile) die('--signature or --signature-file is required');
  return args;
}

/** Tauri 配置里的 pubkey = base64(minisign 公钥文件全文)；这里剥到 42 字节的 key 记录。 */
function decodePublicKey(pubkeyBase64) {
  const publicKeyText = Buffer.from(pubkeyBase64.trim(), 'base64').toString('utf8');
  const lines = publicKeyText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const keyLine = lines.find((l) => !l.startsWith('untrusted comment') && !l.startsWith('trusted comment'));
  if (!keyLine) die('public key record not found (bad --pubkey)');
  const raw = Buffer.from(keyLine, 'base64');
  if (raw.length !== 42) die(`public key record length ${raw.length} != 42`);
  const alg = raw.subarray(0, 2).toString('ascii');
  if (alg !== 'Ed') die(`unsupported public key algorithm: ${alg}`);
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10, 42) };
}

/** latest.json 的 signature / .sig 文件内容 = base64(minisign 签名文件全文)。 */
function decodeSignature(signatureBase64) {
  const signatureText = Buffer.from(signatureBase64.trim(), 'base64').toString('utf8');
  const lines = signatureText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const dataLines = lines.filter((l) => !l.startsWith('untrusted comment') && !l.startsWith('trusted comment'));
  if (dataLines.length < 1) die('signature record not found (bad --signature)');
  const raw = Buffer.from(dataLines[0], 'base64');
  if (raw.length !== 74) die(`signature record length ${raw.length} != 74`);
  // minisign 两种签名形态：'Ed' = 对原文直接签；'ED' = 先 BLAKE2b-512 预哈希再签。
  // tauri-cli 2.12.1 signer 产出的是 'ED'（实测），客户端 minisign-verify 同样按 alg 分支。
  const alg = raw.subarray(0, 2).toString('ascii');
  if (alg !== 'Ed' && alg !== 'ED') die(`unsupported signature algorithm: ${alg}`);
  return { keyId: raw.subarray(2, 10), signature: raw.subarray(10, 74), prehashed: alg === 'ED' };
}

const args = parseArgs(process.argv.slice(2));
const data = readFileSync(args.file);
const { keyId, key } = decodePublicKey(args.pubkey);
const signatureText = args.signatureFile ? readFileSync(args.signatureFile, 'utf8') : args.signature;
const sig = decodeSignature(signatureText);

if (!keyId.equals(sig.keyId)) {
  die(`key id mismatch: pubkey=${keyId.toString('hex')} signature=${sig.keyId.toString('hex')}`);
}

const publicKey = createPublicKey({
  key: Buffer.concat([ED25519_SPKI_PREFIX, key]),
  format: 'der',
  type: 'spki',
});

let ok = false;
try {
  const signedBytes = sig.prehashed ? createHash('blake2b512').update(data).digest() : data;
  ok = edVerify(null, signedBytes, publicKey, sig.signature);
} catch (err) {
  die(`verification error: ${err instanceof Error ? err.message : String(err)}`);
}

if (!ok) die(`signature does not match file bytes (${args.file}, ${data.length} bytes)`);

console.log(
  `[verify-sig] OK keyId=${keyId.toString('hex')} bytes=${data.length} file=${args.file}`,
);
