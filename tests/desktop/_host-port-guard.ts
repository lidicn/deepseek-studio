/**
 * 测试用「本机 host 监听端口」守卫（GATE#67~#70 三连修后的定稿机制）。
 *
 * ## 为什么要这个文件
 *
 * `fetch()`（Node 24 内置 undici）在**发包之前**按 WHATWG fetch 规范的 blocked-port 表
 * 校验端口号，命中就同步抛 `TypeError: fetch failed` ＋ `cause: Error: bad port`——
 * 服务器可能一切正常、请求根本没发出去。实测（本机 Node v24.14.0）：
 *   1719 / 1720 / 1723 / 2049 / 6667 → `bad port`；1721 / 1722 / 15001 → 200。
 * 同一台 server 用 `node:http` 直连 200、`bind` 也成功 ⇒ 拦截发生在**客户端取数层**。
 *
 * ⇒ 测试里凡是"起本机 host 再 `fetch` 它"，都必须保证监听端口不在那张表里。
 *
 * ## 为什么不再自己枚举端口（历史三版，别再回退）
 *
 * 1. `port: 0`（OS 分配）＋ 不校验         ⇒ OS 动态范围内会落进禁用表。
 *    **命中的分子不是表长**：整表 82 条，但落在本机动态范围（1024–15000）内的只有
 *    **19 条**（1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665–6669,
 *    6679,6697,10080）⇒ 理论 **19/13977 ≈ 0.136%/次**；实测两次扫描 7000 次命中 12 次＝
 *    **0.17%**（8/3000＝0.27%、4/4000＝0.10%）。**把表长 82 当命中数会高估 82/19 = 4.32 倍。**
 * 2. 自己枚举、底数 15000                    ⇒ 禁用表 max=10080，跳过分支**永不可达**
 *    （被 PM 实测量化证伪：零信息量断言）。
 * 3. 自己枚举、底数 1024                     ⇒ 跳过分支可达了，但会撞 **Windows 保留段**
 *    （bind 报 `EACCES`，实测 1150/1200/1400/1500/5357/12680/47001 全是 EACCES）；
 *    再改成"EACCES 也换号"后仍有残余：起点模运算落到 50000–50059（管理员排除段）时，
 *    40 次顺序换号全在段内 ⇒ 抛异常（本机 200 个 pid 偏移里有 1 个，≈0.5%）。
 *
 * ## 现在的机制（PM 裁定的方向）
 *
 * **端口由 OS 分配**（`port: 0`）——OS **从不**把保留段端口发出去，所以 EACCES 一类
 * 从机制上消失；**拿到端口后显式校验禁用表**，命中就换下一个 OS 分配（上限明确、
 * 断言写死）。这样两类缺陷（保留段 EACCES / 禁用表 bad port）同时消掉。
 *
 * ⚠ **不得把本机 `netsh` 的保留段硬编码进测试**：那是**机器相关事实**，GitHub runner
 * 与本机不同；写死只会"本机绿、CI 照旧炸"。（PM 第 98 件）
 *
 * ⚠ **CI 也是 Windows**：`ci.yml` L16／L34 与 `release.yml` L40 全是 `windows-latest`
 * ⇒ 本仓 CI **跑的就是 Windows**，有自己的 netsh 保留段与动态范围，**这张禁用表在 CI
 * 上同样可能命中**。所以本机制不是"只保护本机"，它保护**所有跑这套测试的 Windows 环境**。
 * （先前此处写过"CI（Linux）动态范围与表无交集 ⇒ CI 不可能命中"，那是未核对的论断，
 * 已按实测更正：CI 上没有 Linux 跑这套测试。）
 *
 * ⚠ 禁用表本身是 **spec 表**、随 Node/undici 版本可能增减；升级 Node 时复核办法见
 * `isBlockedPort` 上方注释。注意 CI（Linux）动态范围 32768–60999 与表的最大值 10080
 * 无交集 ⇒ 在 CI 上这张表不可能命中，本机制主要保护**本机 Windows**（1024–14999）。
 */

/** WHATWG fetch 规范的 blocked-port 表（本表按 Node v24.14.0 抄录：82 条，已剔除白名单放行的 80/443）。 */
export const UNDICI_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/**
 * 这些 errno 表示"这个端口这次用不了"，换下一个即可。
 *
 * `EACCES` 是 Windows 保留段的真实报法（不是 `EADDRINUSE`）——实测见文件头第 3 版历史。
 * 现在端口由 OS 分配、保留段天然不会发放，但保留这三态是为了**不把"端口不可用"与
 * "配置错误"混为一谈**：只有这三类进换号路径，其余原样上抛。
 */
export const PORT_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'EADDRINUSE',
  'EACCES',
  'EADDRNOTAVAIL',
]);

/**
 * 换号上限：写死、可断言。
 *
 * ⚠ **不能按"每次独立抽签"算概率**（PM 实测量化：连续 600 次 `listen(0)` 里 592/599＝98.8%
 * 相邻差值 +1）。顺序发号意味着**命中禁用表时后续几次也极可能连续命中**——
 * 禁用表里的连续段由测试用 `longestBlockedRun()` 现算并断言：
 * `MAX_LISTEN_ATTEMPTS > 最长连续段`。当前最长段＝5（`19–23` 与 `6665–6669`），且
 * `6665–6669` 全在 Windows 动态范围（1024–14999）内 ⇒ **首分配恰好落到 6665 时，
 * 必须连跳 5 个才能走到 6670**；上限 5 会在这一段上直接打死整枚用例（≈0.47%/闸）。
 *
 * 取 **16**（PM 裁定）：给未来 Node/undici 往表里加端口、拉长连续段留足余量；
 * 余量耗尽时只是"多试几次"，不会误红。下界由断言自动守护——表里连续段一旦 ≥16，测试先红。
 */
export const MAX_LISTEN_ATTEMPTS = 16;

/**
 * 端口是否落在 undici 禁用表里。
 *
 * 升级 Node 后的复核办法：① 跑本仓测试，若又出现 `cause: bad port` ⇒ 表漏了新增项，补进来；
 * ② 反向核对：逐个端口 `fetch` 一遍（必然没人监听也没关系，`bad port` 在发包前就抛），
 *    与表做 diff 应为空。
 */
export function isBlockedPort(port: number): boolean {
  return UNDICI_BLOCKED_PORTS.has(port);
}

/**
 * 禁用表里**最长连续段**的长度（纯函数，负控与上限断言共用）。
 *
 * 用途：`MAX_LISTEN_ATTEMPTS` 必须 > 这个数——OS 顺序分配下，从段首开始要连跳整段。
 */
export function longestBlockedRun(): number {
  const ports = [...UNDICI_BLOCKED_PORTS].sort((a, b) => a - b);
  let best = 1;
  let run = 1;
  for (let i = 1; i < ports.length; i += 1) {
    run = ports[i] === ports[i - 1] + 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return ports.length === 0 ? 0 : best;
}

/**
 * 从"OS 依次分配给我们的端口"里挑第一个可用的（纯函数，负控直接打)。
 *
 * 返回 `null` ＝这一批全落进禁用表 ⇒ 调用方必须换一批（而不是硬用一个坏端口）。
 */
export function pickUsablePort(assigned: readonly number[]): number | null {
  for (const port of assigned) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    if (isBlockedPort(port)) continue;
    return port;
  }
  return null;
}

/** 该错误是否属于"端口这次用不了"（其余错误不进换号路径，原样上抛）。 */
export function shouldRetryListen(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && PORT_UNAVAILABLE_CODES.has(code);
}

interface Listenable {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
}

/**
 * 起一个本机 host，保证它的监听端口不在 undici 禁用表里。
 *
 * `make()` 每次必须新建实例并把 `port` 设成 **0**（交给 OS 分配）——不要传固定端口，
 * 固定/自选端口就是前面三版踩的坑。
 */
export async function startListenable<T extends Listenable>(make: () => T): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_LISTEN_ATTEMPTS; attempt += 1) {
    // ⚠ 每次尝试都**新建实例**（`make()` 再调一次）：换号必须是新的 listen，
    // 复用同一个实例再 `start()` 未经验证，不假定它可重入。
    const instance = make();
    try {
      await instance.start();
    } catch (error) {
      lastError = error;
      try {
        await instance.stop();
      } catch {
        /* 未起来 */
      }
      if (shouldRetryListen(error)) continue;
      throw error; // 非端口问题：原样抛，不吞
    }
    const bound = Number(new URL(instance.url).port);
    if (pickUsablePort([bound]) === null) {
      // OS 恰好发了禁用端口（本机 1024–14999 才有这种可能）：停掉换下一个
      try {
        await instance.stop();
      } catch {
        /* 已停 */
      }
      lastError = new Error(`监听端口 ${bound} 落在 undici 禁用表内（fetch 会在发包前抛 bad port）`);
      continue;
    }
    return instance;
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`起本机 host 失败：${MAX_LISTEN_ATTEMPTS} 次尝试均未拿到可用端口`);
}
