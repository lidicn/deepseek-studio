/**
 * MCP spawn 落点解析（K7，2026-11-09）。
 *
 * ── 为什么要有这个模块 ──────────────────────────────────────────────
 * `mcp.call`／`mcp.save` 的判定面里**看不见 spawn 落点**，是两枚不同的形状：
 *   - `mcp.call`：问是会问的（always 类逐次问），但**问询里没有"要 spawn 到哪儿"**；
 *   - `mcp.save`：保存那一刻**根本不问落点**。
 * 两处落点都来自**已持久化／将要持久化的 server 配置**的 `cwd`，不在调用参数里。
 *
 * ── 同源不变量（台账定字） ────────────────────────────────────────
 * **判定输入的落点 ＝ 能力层 `spawn` 实际使用的落点。**
 *   - 第一个实例＝#49（`mcp.test` 的 `config.cwd` 由调用方给，判定与 spawn 同一份）；
 *   - 第二个实例＝K7（落点在持久化配置里，所以判定必须读解析结果）。
 * 将来若有第三枚同族缺口，挂同一条判据，不要各写一套。
 *
 * ── 本模块的纪律 ──────────────────────────────────────────────────
 * 1. **纯函数、零依赖**：只吃"一份配置"，不 import controller、不读环境变量、不碰 fs。
 *    内部**绝不自取配置**——否则 `mcp.save` 那侧只能读到旧配置，
 *    「保存时提前告知」直接失效（两条信任边界见下）。
 * 2. **由调用点决定给哪一份配置**：
 *    - `mcp.call` ⇒ 已存的那份（`McpController#getServerConfig`，类方法，`mcp-controller.ts` L992）；
 *    - `mcp.save` ⇒ 本次要存的那份（`desktop-host.ts` handler 的 `params.config`，
 *      与 `L828/L837` 落盘用的是同一个值）。
 * 3. **策略层仍然纯函数**：解析结果由 host 侧作为普通字段 `spawnCwd` 塞进"判定用对象"，
 *    `evaluatePolicy` 只看到 `params.spawnCwd`，不知道 MCP 的存在。
 *
 * ── 两条信任边界（不是冗余，是两格） ──────────────────────────────
 * `mcp.save` 的 config 来自**模型可写参数**，所以"保存时判"**不能替代**"连接时判"：
 * 模型可以 save 一份区内 cwd 的配置、之后被手改成区外，或直接 save 一份区外的让用户点同意。
 * 而 `mcp.call` 才是真正 spawn 的那一发。⇒ 两处都判。
 */

/**
 * 一份 MCP server 配置里与落点相关的部分。
 *
 * 只声明本模块真正读的字段（结构化子集），两边的完整类型都能直接传进来。
 */
export interface SpawnTargetSource {
  readonly cwd?: string | null;
}

/** 落点解析结果。`source` 用于审计／测试区分"这份 cwd 是哪来的"。 */
export interface SpawnTarget {
  /** 显式配置的落点；`null` ＝配置里没有（能力层此时让子进程继承宿主进程 cwd）。 */
  readonly cwd: string | null;
  /** `'config'`＝来自配置；`'none'`＝配置里没写。 */
  readonly source: 'config' | 'none';
}

/**
 * 从**一份**配置解析 spawn 落点。
 *
 * 空串／纯空白的 `cwd` 按"没写"处理：`desktop-host.ts` 的 handler 用
 * `typeof config.cwd === 'string' ? config.cwd : undefined` 构造配置，
 * 空串会原样落盘成 `""`，而 `spawn` 拿到 `""` 时的行为与 `undefined` 不同
 * （Node 会把它当路径解析并可能直接 ENOENT）——所以我们**如实报它存在**，
 * 不做"空串等于没写"的静默归一：那样会让判定值与实际落点分叉，正好违反同源不变量。
 *
 * @param source 配置对象，或 `null`（服务器不存在）
 */
export function resolveSpawnTarget(source: SpawnTargetSource | null | undefined): SpawnTarget {
  if (!source || typeof source !== 'object') return { cwd: null, source: 'none' };
  const raw = source.cwd;
  if (typeof raw !== 'string') return { cwd: null, source: 'none' };
  return { cwd: raw, source: 'config' };
}

/** 只有这两枚工具需要 `spawnCwd`（见 `buildPolicyParams` 的注释）。 */
const SPAWN_TOOLS: readonly string[] = ['mcp.call', 'mcp.save'];

/**
 * 构造**只给策略层用**的参数对象（K7 硬约束第 4 条）。
 *
 * ── 为什么不能 `{ ...paramsBag, spawnCwd }` ──
 * `desktop-host.ts` 里 `paramsBag` 与 `params` 是**同一个对象**（类型断言不是拷贝），
 * 而调用方能在 `mcp.call` 的 `params` 里自带一个**区内** `cwd`。浅拷贝会把它带进来，
 * `policy.ts` 的判据是"顶层优先"⇒ 越界会被判成不越界。
 * 今天之所以没炸，只是因为 `mcp.call` 不在 `PROCESS_TOOLS`、走不到那行——
 * **那是分支可达性的巧合，不是契约**（与"三合一条件"拒绝的那种成立方式同源）。
 *
 * ⇒ **剔除** `cwd`／`workdir`，再放 `spawnCwd`：判定输入只能是解析结果，
 * 这条不变量变成**对象形状上的事实**，不依赖任何分支是否被走到。
 *
 * ⚠️ 只作用于这一份对象。`checkHardDeny`／`whitelistHit`／`lookupGrant`／
 * `resolveAuthorization`／`routeExecution` 必须继续吃**原** `paramsBag`：
 * 多一个字段会让 grant key 的取值面改变（同一目标不再命中同一 key ⇒ 静默不命中），
 * 也会让审计里的 `canonicalTarget` 指向错误目标——比"不命中"更难查。
 *
 * `spawnCwd` 只加给 `mcp.call`／`mcp.save`：`python.exec` 也在 `EXECUTION_TOOLS` 里，
 * 给它凭空造一个入参等于让一条为 `mcp.*` 写的分支去接管它的行为。
 *
 * ── ⚠️ 剔除的范围只限 `SPAWN_TOOLS`（R50-1，2026-11-09 闸红后修） ──
 * 第一版把剔除做成了**无条件**（先解构、再按工具决定加不加 `spawnCwd`），后果是：
 * `shell.exec`／`file.write`／`python.exec` 等**非 MCP 工具**进策略层时，
 * 顶层 `cwd`／`workdir` 被整体抹掉 ⇒ `policy.ts` 的 `L411`（顶层优先，`#49` 的成果）
 * 取不到值 ⇒ `outside` 恒 false ⇒ **`#49` 刚接上的越界判定被反向抹掉**，
 * 且 `authorization.ts` 的 `!outsideRequested` 从此恒真 ⇒ 对话级放行吃得到越界。
 * 本批 34 枚新测试没抓住，因为它们直连 `evaluatePolicy`、绕开了这个注入点。
 *
 * ⇒ 非 MCP 工具**原引用返回**（连拷贝都不产生）：既保住 `#49` 的口径，
 * 也不给"第二份看起来安全其实没生效的拷贝"留余地。
 */
export function buildPolicyParams(
  tool: string,
  paramsBag: Record<string, unknown>,
  spawnTarget: SpawnTarget,
): Record<string, unknown> {
  // 只有这两枚工具的"落点"不在调用参数里；其余工具原样进策略层（`#49` 口径不动）。
  if (!SPAWN_TOOLS.includes(tool)) return paramsBag;
  const { cwd: _dropCwd, workdir: _dropWorkdir, ...rest } = paramsBag;
  const out: Record<string, unknown> = { ...rest };
  out.spawnCwd = spawnTarget.cwd;
  return out;
}
