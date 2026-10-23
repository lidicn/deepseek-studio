/**
 * DeepSeek PoW（Proof of Work）模块
 * 参考 deepseek++ src/core/deepseek/pow.ts + active-client.ts
 *
 * 流程：
 * 1. POST /api/v0/chat/create_pow_challenge 获取 challenge
 * 2. 用 WASM (sha3) 算 POW answer
 * 3. 构造 X-DS-PoW-Response header (Base64 JSON)
 */

import { WASM_BASE64 } from './pow-wasm';

const SUPPORTED_ALGORITHM = 'DeepSeekHashV1';

interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  signature: string;
  expire_at: number;
  expire_after?: number;
  received_at: number;
}
interface PowAnswer {
  algorithm: string;
  challenge: string;
  salt: string;
  answer: number;
  signature: string;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  wasm_solve(retPtr: number, challengePtr: number, challengeLen: number, prefixPtr: number, prefixLen: number, difficulty: number): void;
  __wbindgen_add_to_stack_pointer(offset: number): number;
  __wbindgen_export_0(size: number, align: number): number;
}

let wasmInstance: WasmExports | null = null;
const textEncoder = new TextEncoder();

async function loadWasm(): Promise<WasmExports> {
  if (wasmInstance) return wasmInstance;
  // 内嵌 base64 WASM，避免页端相对路径 fetch 返回 404 HTML
  const binary = Uint8Array.from(atob(WASM_BASE64), (c) => c.charCodeAt(0));
  const { instance } = await WebAssembly.instantiate(binary, {});
  wasmInstance = instance.exports as unknown as WasmExports;
  return wasmInstance;
}

function writeWasmString(wasm: WasmExports, value: string): { ptr: number; len: number } {
  const bytes = textEncoder.encode(value);
  const ptr = wasm.__wbindgen_export_0(bytes.length, 1);
  new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
  return { ptr, len: bytes.length };
}

function solvePowWithWasm(wasm: WasmExports, target: string, prefix: string, difficulty: number): number {
  const retPtr = wasm.__wbindgen_add_to_stack_pointer(-16);
  const challengeAlloc = writeWasmString(wasm, target);
  const prefixAlloc = writeWasmString(wasm, prefix);
  try {
    wasm.wasm_solve(retPtr, challengeAlloc.ptr, challengeAlloc.len, prefixAlloc.ptr, prefixAlloc.len, difficulty);
    const view = new DataView(wasm.memory.buffer);
    const status = view.getInt32(retPtr, true);
    const answer = view.getFloat64(retPtr + 8, true);
    if (status !== 1 || !Number.isSafeInteger(answer) || answer < 0) {
      throw new Error(`No PoW solution found before difficulty ${difficulty}`);
    }
    return answer;
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}

async function createPowChallenge(headers: Record<string, string>, targetPath: string): Promise<PowChallenge> {
  const requestHeaders = buildPowChallengeHeaders(headers);
  const resp = await fetch('/api/v0/chat/create_pow_challenge', {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ target_path: targetPath }),
    credentials: 'include',
  });
  const respText = await resp.text();
  if (!resp.ok) throw new Error(`PoW challenge failed: ${resp.status} ${respText.slice(0, 200)}`);
  const data = JSON.parse(respText);
  // deepseek++ 解析：json.data.biz_data.challenge
  const challenge = data?.data?.biz_data?.challenge ?? data?.data?.challenge ?? data?.challenge ?? data;
  if (!challenge?.challenge) throw new Error(`Invalid PoW challenge response: ${respText.slice(0, 300)}`);
  return {
    algorithm: String(challenge.algorithm),
    challenge: String(challenge.challenge),
    salt: String(challenge.salt),
    difficulty: Number(challenge.difficulty),
    signature: String(challenge.signature),
    expire_at: Number(challenge.expire_at ?? challenge.expireAt ?? 0),
    expire_after: Number(challenge.expire_after ?? challenge.expireAfter ?? 0),
    received_at: Date.now(),
  } as PowChallenge;
}

/**
 * 捕获到的请求头通常已含 content-type。fetch/Headers 按大小写不敏感合并，
 * 再额外补一个同名头会变成 `application/json, application/json`，服务端 422。
 */
export function buildPowChallengeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'content-type') out[key] = value;
  }
  out['Content-Type'] = 'application/json';
  return out;
}

export function isPowChallengeExpired(
  challenge: Pick<PowChallenge, 'expire_at' | 'expire_after' | 'received_at'>,
  now = Date.now(),
): boolean {
  if (Number.isFinite(challenge.expire_at) && challenge.expire_at > 0) {
    const expiresAtMs = challenge.expire_at < 1_000_000_000_000
      ? challenge.expire_at * 1000
      : challenge.expire_at;
    if (now >= expiresAtMs) return true;
  }
  if (Number.isFinite(challenge.expire_after) && (challenge.expire_after ?? 0) > 0) {
    if (now >= challenge.received_at + (challenge.expire_after as number) * 1000) return true;
  }
  return false;
}

function base64EncodeUtf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * 计算 POW 并返回 headers
 * @param headers 客户端 headers（含 Authorization）
 * @param targetPath 目标路径（默认 /api/v0/chat/completion）
 */
export async function createPowHeaders(
  headers: Record<string, string>,
  targetPath = '/api/v0/chat/completion',
): Promise<Record<string, string>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const challenge = await createPowChallenge(headers, targetPath);
    if (challenge.algorithm !== SUPPORTED_ALGORITHM) {
      throw new Error(`Unsupported PoW algorithm: ${challenge.algorithm}`);
    }
    if (isPowChallengeExpired(challenge)) {
      if (attempt === 0) continue;
      throw new Error('pow-expired');
    }
    const wasm = await loadWasm();
    const prefix = `${challenge.salt}_${challenge.expire_at}_`;
    const answer = solvePowWithWasm(wasm, challenge.challenge.toLowerCase(), prefix, challenge.difficulty);
    if (isPowChallengeExpired(challenge)) {
      if (attempt === 0) continue;
      throw new Error('pow-expired');
    }
    const powAnswer: PowAnswer = {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
    };
    return {
      'X-DS-PoW-Response': base64EncodeUtf8(JSON.stringify({ ...powAnswer, target_path: targetPath })),
    };
  }
  throw new Error('pow-expired');
}
