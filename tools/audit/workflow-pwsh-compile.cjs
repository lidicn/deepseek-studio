#!/usr/bin/env node
/**
 * tools/audit/workflow-pwsh-compile.cjs —— workflow 内嵌 pwsh 脚本编译闸（R-2 缺口加固）
 *
 * v0.14.14 release run 红在 step 9：`$attempt:` 被 PowerShell 当驱动器前缀 ⇒ 解析期死、
 * 整块不跑。闸与 CI 都没检查 workflow 内嵌脚本的语法——"闸绿≠workflow 能跑"第二例。
 *
 * 原理：遍历 .github/workflows/*.yml → yaml 真解 → 找 shell: pwsh（或 runs-on windows 时
 * 无 shell 声明的单行 run）的步 → 先把 ${{ }} 替换为等长占位符 → 落盘临时文件 →
 * 调 PowerShell Parser::ParseFile 真解析 → errors 必须 0。
 *
 * 必须落盘再 ParseFile（Gate 实测：跨进程传串时 CRLF 被 node stdout 吞 ⇒ 永远 0 错、假绿）。
 *
 * 用法（gate 阻塞级）：node tools/audit/workflow-pwsh-compile.cjs
 * 可选 --dir <path>：用指定目录的 .github/workflows/*.yml（负控用副本）。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

let YAML;
try {
  YAML = require('yaml');
} catch {
  console.error('[workflow-pwsh-compile] FAIL: yaml dependency missing');
  process.exit(1);
}

const root = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const di = argv.indexOf('--dir');
let wfDir;
if (di !== -1 && argv[di + 1]) {
  // --dir 直接指向 workflow 文件所在目录（负控用），不需要重建 .github/workflows 结构
  wfDir = path.resolve(argv[di + 1]);
} else {
  wfDir = path.join(root, '.github', 'workflows');
}

if (!fs.existsSync(wfDir)) {
  console.error('[workflow-pwsh-compile] FAIL: workflow dir not found at ' + wfDir);
  process.exit(1);
}

const wfFiles = fs.readdirSync(wfDir).filter(f => f.endsWith('.yml'));
if (wfFiles.length === 0) {
  console.error('[workflow-pwsh-compile] FAIL: no .yml files in .github/workflows');
  process.exit(1);
}

// 替换 ${{ }} 为等长占位符（保持行列号不变）
function replaceExpr(s) {
  return s.replace(/\$\{\{[^}]+\}\}/g, (m) => {
    // 等长：用下划线填充
    let pad = '_'.repeat(m.length - 2);
    return '_' + pad.slice(0, -1); // 保持总长度
  });
}

let blocksParsed = 0;
let blocksSkipped = 0;
const allErrors = [];

for (const wfFile of wfFiles) {
  const wfPath = path.join(wfDir, wfFile);
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(wfPath, 'utf8'));
  } catch (e) {
    allErrors.push({ file: wfFile, stepLine: 0, msg: `YAML parse failed: ${e.message}` });
    continue;
  }
  if (!doc.jobs) continue;

  for (const [jobId, job] of Object.entries(doc.jobs)) {
    const runsOn = job['runs-on'] || '';
    const isWindowsRunner = typeof runsOn === 'string' && runsOn.includes('windows');
    if (!job.steps) continue;

    for (let si = 0; si < job.steps.length; si++) {
      const step = job.steps[si];
      if (!step.run) continue;

      const shell = step.shell;
      // 判据：显式 pwsh、或无 shell 声明且 runner 含 windows
      const isPwsh = shell === 'pwsh' || shell === 'powershell' ||
                     (!shell && isWindowsRunner);
      if (!isPwsh) { blocksSkipped++; continue; }

      blocksParsed++;

      // 替换 ${{ }} → 占位符
      const cleaned = replaceExpr(step.run);

      // 落盘再 ParseFile（跨进程传串会丢 CRLF ⇒ 假绿）
      const tmpFile = path.join(os.tmpdir(), `wf-pwsh-${wfFile}-${jobId}-${si}.ps1`);
      fs.writeFileSync(tmpFile, cleaned, 'utf8');

      try {
        const cmd = `pwsh -NoProfile -Command "$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('${tmpFile.replace(/'/g, "''")}',[ref]$null,[ref]$e)|Out-Null;if($e.Count -gt 0){foreach($x in $e){Write-Host('L'+$x.Extent.StartLineNumber.ToString()+': '+$x.Message)};exit 1}"`;
        execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
        // exit 0 = clean
      } catch (e) {
        const stdout = (e.stdout || '').trim();
        if (stdout) {
          for (const line of stdout.split('\n')) {
            const m = line.match(/^(\d+):\s*(.*)/);
            allErrors.push({
              file: wfFile,
              stepLine: si + 1,
              msg: m ? `L${m[1]}: ${m[2]}` : line
            });
          }
        } else {
          allErrors.push({ file: wfFile, stepLine: si + 1, msg: `pwsh parse failed: ${e.message}` });
        }
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    }
  }
}

if (blocksParsed === 0) {
  console.error('[workflow-pwsh-compile] FAIL: blocksParsed=0 (no pwsh blocks found — extraction bug?)');
  process.exit(1);
}

if (allErrors.length > 0) {
  for (const e of allErrors) {
    console.error(`[workflow-pwsh-compile] ${e.file} step#${e.stepLine}: ${e.msg}`);
  }
  process.exit(1);
}

console.log(`[workflow-pwsh-compile] PASS: blocksParsed=${blocksParsed} blocksSkipped=${blocksSkipped} (0 errors)`);
process.exit(0);
