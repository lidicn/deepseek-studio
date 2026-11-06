/**
 * tests/desktop/p1-mcp-get-credential-mask.test.ts
 *
 * P1 安全小卡：`mcp.get` 凭据面收口（2026-11-06）。
 *
 * ── 缺陷 ──
 * `maskMcpServerSecrets`（喂 `mcp.get`）只掩 `env` / `headers`，`url` / `args`
 * **原样透出**；而 F11 的 `toMcpServerSummary`（喂 `mcp.list`）**早就掩了这两个字段**。
 * 两处口径不一致 ⇒ 页内只读弹窗（与站点 JS **同 world**）和模型上下文都能读到
 * `https://user:pass@host` 或 `--token xxx` 里的真凭据。
 *
 * ── 本卡唯一的过修风险（PM 点名）──
 * 「不含凭据的 url 被掩掉」= 把弹窗显示正常地址的功能改坏。故正控与负控同等重要。
 *
 * ── 与掩码成对的还原 ──
 * `mcp.get` 与 `mcp.save` **都是零审批工具**：多掩一个字段而不加还原，
 * `get → save` 回路会把 `****` 写回磁盘，把「防外泄」变成「毁配置」。
 * 故本文件同时锁「掩码」与「还原」两半（R2-02 引入过一模一样的新缺陷）。
 */
import { describe, it, expect } from 'vitest';
import {
  MCP_SECRET_MASK,
  maskMcpServerSecrets,
  maskMcpServerUrl,
  maskMcpServerArgs,
  mergeMaskedSecrets,
  mergeMaskedSecretsChecked,
  toMcpServerSummary,
  type McpServerConfig,
} from '../../src/host/mcp-controller';

describe('负控：含凭据的 url 必须掩码，且与 F11 同口径', () => {
  it('userinfo 里的密码被打码，用户名/主机/路径保留', () => {
    const cfg = {
      transport: 'http',
      url: 'http://user:pass@host.local/mcp',
    } as McpServerConfig;
    const masked = maskMcpServerSecrets(cfg);
    expect(masked.url).not.toContain('pass');
    expect(masked.url).toContain(MCP_SECRET_MASK);
    // 非秘密部分保留（否则弹窗没法显示服务器地址）
    expect(masked.url).toContain('user');
    expect(masked.url).toContain('host.local');
    expect(masked.url).toContain('/mcp');
  });

  it('凭据形态查询参数的值被打码、参数名保留', () => {
    // 用显式字面量，不用占位符：占位符在运行时会被替换成真值，
    // 断言里再写占位符就成了「拿 A 的字面量断 B」的空断言。
    const cfg = {
      transport: 'http',
      url: 'https://host.local/mcp?token=plainTok123&page=2',
    } as McpServerConfig;
    const masked = maskMcpServerSecrets(cfg);
    expect(masked.url).not.toContain('plainTok123');
    expect(masked.url).toContain('token=');
    // 非凭据参数原样保留
    expect(masked.url).toContain('page=2');
  });

  it('掩码形态与 toMcpServerSummary **逐字一致**（同函数同源，不写第二套口径）', () => {
    const cfg = {
      transport: 'http',
      url: 'http://user:pass@host.local/mcp?token=base64url',
    } as McpServerConfig;
    const viaGet = maskMcpServerSecrets(cfg).url;
    const viaList = toMcpServerSummary('srv', cfg).url;
    expect(viaGet).toBe(viaList);
  });

  it('args 里的凭据参数值被打码（--token xxx 与 --token=xxx 两种形态）', () => {
    const cfg = {
      transport: 'stdio',
      command: 'node',
      args: ['srv.js', '--token', 'base64url', '--api-key={{SECRET_4x9dmpzq}}', '--port', '8080'],
    } as McpServerConfig;
    const masked = maskMcpServerSecrets(cfg);
    const joined = (masked.args ?? []).join(' ');
    expect(joined).not.toContain('base64url');
    expect(joined).not.toContain('{{SECRET_4x9dmpzq}}');
    expect(joined).toContain('--token');
    expect(joined).toContain('--api-key=');
    // 非凭据参数原样保留
    expect(masked.args).toContain('--port');
    expect(masked.args).toContain('8080');
    expect(masked.args).toContain('srv.js');
  });

  it('env / headers 的值仍然掩码（R2-02 不回退）', () => {
    const cfg = {
      transport: 'stdio',
      command: 'node',
      env: { API_KEY: 'real-key' },
      headers: { Authorization: 'Bearer real' },
    } as McpServerConfig;
    const masked = maskMcpServerSecrets(cfg);
    expect(masked.env).toEqual({ API_KEY: MCP_SECRET_MASK });
    expect(masked.headers).toEqual({ Authorization: MCP_SECRET_MASK });
  });
});

describe('正控：不含凭据的 url / args **原样返回**（别把功能改坏）', () => {
  it('普通地址一字不改', () => {
    const cfg = { transport: 'http', url: 'https://host.local/mcp' } as McpServerConfig;
    expect(maskMcpServerSecrets(cfg).url).toBe('https://host.local/mcp');
  });

  it('带普通查询参数的地址一字不改（非凭据参数名不打码）', () => {
    const url = 'https://host.local/mcp?page=2&x=1';
    expect(maskMcpServerUrl(url)).toBe(url);
  });

  it('不是合法 URL 的模板串原样返回（不猜、不改写）', () => {
    const templated = '${MCP_URL}/mcp';
    expect(maskMcpServerUrl(templated)).toBe(templated);
  });

  it('无凭据的 args 逐位不变', () => {
    const args = ['srv.js', '--port', '8080', '--verbose'];
    expect(maskMcpServerArgs(args)).toEqual(args);
  });

  it('--token 后面没有值 → 不打码（没有值可打码，也不猜）', () => {
    const args = ['srv.js', '--token'];
    expect(maskMcpServerArgs(args)).toEqual(args);
  });

  it('无 url / 无 args 的配置不新增字段', () => {
    const cfg = { transport: 'stdio', command: 'node' } as McpServerConfig;
    const masked = maskMcpServerSecrets(cfg);
    expect(Object.prototype.hasOwnProperty.call(masked, 'url')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(masked, 'args')).toBe(false);
  });
});

describe('成对还原：get→save 回路不得把 **** 写回磁盘（防毁配置）', () => {
  const disk: McpServerConfig = {
    transport: 'http',
    command: 'node',
    url: 'http://user:pass@host.local/mcp?token=base64url',
    args: ['srv.js', '--token', 'base64url'],
    env: { API_KEY: 'real-key' },
    headers: { Authorization: 'Bearer real' },
  };

  it('原样回写（用户没改）→ 磁盘真值全保留', () => {
    const roundTripped = maskMcpServerSecrets(disk);
    const merged = mergeMaskedSecrets(roundTripped, disk);
    expect(merged.url).toBe(disk.url);
    expect(merged.args).toEqual(disk.args);
    expect(merged.env).toEqual(disk.env);
    expect(merged.headers).toEqual(disk.headers);
  });

  it('用户真的改了地址 → 用新值，不被还原覆盖', () => {
    const incoming = { ...maskMcpServerSecrets(disk), url: 'https://other.host/mcp' } as McpServerConfig;
    const merged = mergeMaskedSecrets(incoming, disk);
    expect(merged.url).toBe('https://other.host/mcp');
  });

  it('用户改了 args 的某一位 → 那一位用新值，其余掩码位仍还原真值', () => {
    const masked = maskMcpServerSecrets(disk);
    const incoming = { ...masked, args: ['srv.js', '--token', 'base64url', '--extra'] } as McpServerConfig;
    // 长度变了（用户新增参数）→ 不按下标还原，整份按用户输入走
    const merged = mergeMaskedSecrets(incoming, disk);
    expect(merged.args).toEqual(['srv.js', '--token', 'base64url', '--extra']);
  });

  it('同长度下掩码位还原、用户改过的位保留', () => {
    const masked = maskMcpServerSecrets(disk);
    const incoming = {
      ...masked,
      args: ['srv-new.js', masked.args![1], masked.args![2]],
    } as McpServerConfig;
    const merged = mergeMaskedSecrets(incoming, disk);
    expect(merged.args).toEqual(['srv-new.js', '--token', 'base64url']);
  });

  it('没有既有配置（新建）→ 原样返回，不做还原', () => {
    const incoming = maskMcpServerSecrets(disk);
    expect(mergeMaskedSecrets(incoming, null)).toEqual(incoming);
  });
});

describe('裁定五十一：段级/元素级还原 + 歧义拒写（fail-closed）', () => {
  const disk: McpServerConfig = {
    transport: 'http',
    command: 'node',
    url: 'http://user:{{PASSWORD_9kdmz3qv}}@old.host:8080/mcp?token={{SECRET_9kdmz3qv}}',
    args: ['srv.js', '--token', '{{SECRET_9kdmz3qv}}', '--port', '8080'],
  };

  it('用户只改了 host、密码位仍是掩码 → **密码必须保留**（不得把 **** 写成密码）', () => {
    const masked = maskMcpServerSecrets(disk);
    const changedHost = (masked.url ?? '').replace('old.host', 'new.host');
    const incoming = { ...masked, url: changedHost } as McpServerConfig;

    const r = mergeMaskedSecretsChecked(incoming, disk);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.url).toContain('new.host'); // 用户的改动生效
      expect(r.config.url).toContain('{{PASSWORD_9kdmz3qv}}'); // 密码是磁盘真值
      expect(r.config.url).not.toContain(MCP_SECRET_MASK);
    }
  });

  it('查询参数是掩码位、同名参数在磁盘上存在 → 还原真值', () => {
    const masked = maskMcpServerSecrets(disk);
    const r = mergeMaskedSecretsChecked(masked, disk);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.url).toContain('{{SECRET_9kdmz3qv}}');
      expect(r.config.url).not.toContain(MCP_SECRET_MASK);
    }
  });

  it('args 跨位配对：用户在掩码位前后插入了元素，掩码位仍按 flag 名还原', () => {
    const incoming = {
      ...disk,
      args: ['--verbose', 'srv.js', '--token', MCP_SECRET_MASK, '--port', '9090'],
    } as McpServerConfig;
    const r = mergeMaskedSecretsChecked(incoming, disk);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.args).toEqual(['--verbose', 'srv.js', '--token', '{{SECRET_9kdmz3qv}}', '--port', '9090']);
    }
  });

  it('args 的 `--flag=掩码` 形态按 flag 名还原', () => {
    const incoming = {
      ...disk,
      args: ['srv.js', '--token=' + MCP_SECRET_MASK],
    } as McpServerConfig;
    const r = mergeMaskedSecretsChecked(incoming, disk);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.args).toEqual(['srv.js', '--token={{SECRET_9kdmz3qv}}']);
  });

  it('歧义①：url 掩码位在磁盘上没有对应原值 → **拒写**（不是猜一个）', () => {
    const incoming = {
      ...disk,
      url: 'http://user:' + MCP_SECRET_MASK + '@old.host:8080/mcp?token=' + MCP_SECRET_MASK,
    } as McpServerConfig;
    const noDisk: McpServerConfig = { transport: 'http', command: 'node' };
    const r = mergeMaskedSecretsChecked(incoming, noDisk);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unresolved-mask');
  });

  it('歧义②：args 掩码位找不到同 flag 的磁盘原值 → 拒写', () => {
    const incoming = {
      ...disk,
      args: ['srv.js', '--secret-key', MCP_SECRET_MASK],
    } as McpServerConfig;
    const r = mergeMaskedSecretsChecked(incoming, disk);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('--secret-key');
  });

  it('歧义③：url 含掩码但不是可解析 URL → 拒写（不猜）', () => {
    const incoming = { ...disk, url: 'not-a-url-' + MCP_SECRET_MASK } as McpServerConfig;
    const r = mergeMaskedSecretsChecked(incoming, disk);
    expect(r.ok).toBe(false);
  });

  it('硬不变量：合并后 url/args 里 **任何位置都不得残留 ******', () => {
    const masked = maskMcpServerSecrets(disk);
    const r = mergeMaskedSecretsChecked(masked, disk);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.url ?? '').not.toContain(MCP_SECRET_MASK);
      expect((r.config.args ?? []).join(' ')).not.toContain(MCP_SECRET_MASK);
      // 且逐字节等于磁盘原值（强断言，不是「不等于 ****」）
      expect(r.config.url).toBe(disk.url);
      expect(r.config.args).toEqual(disk.args);
    }
  });

  // 兼容入口的语义就是「歧义 → 抛错」：checked 版返回对象、老签名只能抛。
  // 三条歧义用例走的是 checked 入口（每个用例自己的断言），这条只锁老入口的抛错行为。
  it('兼容入口 mergeMaskedSecrets：歧义时**抛错**而非静默写 ****', () => {
    const incoming = { ...disk, args: ['--nope', MCP_SECRET_MASK] } as McpServerConfig;
    expect(() => mergeMaskedSecrets(incoming, disk)).toThrow(/unresolved-mask/);
  });
});

describe('裁定五十三：编码不变性（原始串手术 —— 禁止解析→重序列化）', () => {
  // 夹具用**纯字面量**（裁定五十二）：含 URL 特殊字符 + 非 ASCII 各至少一类。
  // 纯字面量（裁定五十二）：不得用占位符形状，否则运行时被替换、夹具与断言各说各话。
  const SPECIAL_PW = 'p' + String.fromCharCode(123) + 'w' + String.fromCharCode(125) + 'z+1';
  const disk: McpServerConfig = {
    transport: 'http',
    command: 'node',
    url: 'http://u:' + SPECIAL_PW + '@h.local/mcp?token=' + SPECIAL_PW + '&page=2',
    args: ['srv.js', '--token', SPECIAL_PW, '--flag=a=b', '', '--uni', SPECIAL_PW],
  };

  // ── 夹具前置断言（PM 裁定：凡是「负控必须真红」的测试，都要证明它真的走到了被测分支）──
  // 没有这段，若有人把夹具换成不可解析形态，URL 构造抛错 → 两条路径巧合一致 →
  // 本负控**静默变绿**，而那正是「重序列化缺陷不存在」的最坏假信号。
  it('夹具自检：URL 可解析、含查询串、且含会被重编码的字符', () => {
    expect(() => new URL(disk.url ?? '')).not.toThrow();
    const u = new URL(disk.url ?? '');
    expect(u.search.length).toBeGreaterThan(0); // 有查询串（&page=2）
    // 密码段能被解析出来（值会被 harness 替换成真实密钥，故不比字面量，只验它是同一段）
    expect(u.password.length).toBeGreaterThan(0);
    // 密码段确实是 userinfo 的一部分（定位用 indexOf，不拼可能被替换的凭据值）
    const authStart = (disk.url ?? '').indexOf('://u:');
    const authEnd = (disk.url ?? '').indexOf('@h.local');
    expect(authStart).toBeGreaterThanOrEqual(0);
    expect(authEnd).toBeGreaterThan(authStart);
    // 含会被 URL 重编码的字符：{ / } 必须存在，否则这条负控测不到重编码
    expect(SPECIAL_PW).toMatch(/[{}]/);
    // 反向证明：重序列化后**确实**与原始串不同（否则夹具选得没意义）
    expect(u.toString()).not.toBe(disk.url);
  });

  it('mask → 还原 → 写回：url **逐字节等于**原串（字符串全等，不用解析比较）', () => {
    const masked = maskMcpServerSecrets(disk);
    const r = mergeMaskedSecretsChecked(masked, disk);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.url).toBe(disk.url); // toBe：全等，重编码会当场红
  });

  it('args 逐元素全等（引号/空元素/`=` 分割都不许漂移）', () => {
    const masked = maskMcpServerSecrets(disk);
    const r = mergeMaskedSecretsChecked(masked, disk);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.args).toEqual(disk.args);
  });

  // 裁定五十三 §2「演示真红」的**专用负控**。两条设计约束：
  //  ① 凭据用**低熵构造串**（`pw-{x}`），运行环境没有可替换的密钥形状 ⇒ 红证据原样可读；
  //  ② 入参的凭据位**必须留掩码**（`hasMask(incoming.url)` 为真），否则根本进不了
  //     `mergeMaskedUrlRaw` —— 第五次装置伪绿的形状就是入参喂了真值、整条分支没执行。
  it('磁盘值含 { } + 非 ASCII，用户只改 host → 写回后凭据段不得被重编码', () => {
    const L = String.fromCharCode(123); // {
    const R = String.fromCharCode(125); // }
    const pw = 'pw-' + L + 'x' + R + '-' + String.fromCharCode(0x6d4b) + '+1';
    expect(pw.length).toBe(10);
    const dsk: McpServerConfig = {
      transport: 'http',
      command: 'node',
      url: 'http://u:' + pw + '@h.local/mcp?token=' + pw + '&page=2',
    };
    // 前置断言：URL 可解析（否则两条路径巧合一致 ⇒ 负控静默变绿）
    expect(() => new URL(dsk.url ?? '')).not.toThrow();
    const masked = maskMcpServerSecrets(dsk);
    // 前置断言：入参确实带掩码 ⇒ 真的会走 mergeMaskedUrlRaw
    expect(masked.url).toContain(MCP_SECRET_MASK);
    const incoming = { ...masked, url: (masked.url ?? '').replace('h.local', 'new.local') } as McpServerConfig;
    expect(incoming.url).not.toContain(pw); // 入参里不出现真值 ⇒ 红时看见的是重编码形态
    const r = mergeMaskedSecretsChecked(incoming, dsk);
    expect(r.ok).toBe(true);
    // 期望 = 磁盘真值 + 用户改的那一段，逐字节全等；重编码会显示成 pw-%7Bx%7D-…
    if (r.ok) expect(r.config.url).toBe((dsk.url ?? '').replace('h.local', 'new.local'));
  });

  it('用户只改 host 时，凭据段仍是磁盘原值且逐字节相同', () => {
    const masked = maskMcpServerSecrets(disk);
    const incoming = { ...masked, url: (masked.url ?? '').replace('h.local', 'new.local') } as McpServerConfig;
    const r = mergeMaskedSecretsChecked(incoming, disk);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.url).toBe((disk.url ?? '').replace('h.local', 'new.local'));
    }
  });
});

describe('裁定五十四：checked 契约（可辨识联合真的成立）', () => {
  it('歧义入参：checked **不抛**、返回 {ok:false}（并列断言，缺一不可）', () => {
    const incoming = { transport: 'http', command: 'node', url: 'http://u:' + MCP_SECRET_MASK + '@h/mcp' } as McpServerConfig;
    const noDisk: McpServerConfig = { transport: 'http', command: 'node' };
    expect(() => mergeMaskedSecretsChecked(incoming, noDisk)).not.toThrow();
    const r = mergeMaskedSecretsChecked(incoming, noDisk);
    expect(r.ok).toBe(false);
  });

  it('兼容入口 mergeMaskedSecrets 歧义时**抛错**（老契约保持）', () => {
    const incoming = { transport: 'http', command: 'node', url: 'http://u:' + MCP_SECRET_MASK + '@h/mcp' } as McpServerConfig;
    const noDisk: McpServerConfig = { transport: 'http', command: 'node' };
    expect(() => mergeMaskedSecrets(incoming, noDisk)).toThrow(/unresolved-mask/);
  });
});