/**
 * render-code-runner.ts — 代码块运行按钮（移植自 deepseek++ render-code-runner.ts）
 * @upstream-commit 187f6227 @upstream-path src/core/inline-agent/render-code-runner.ts
 *
 * 功能：
 * - 在 JS/TS/Python 代码块右上角添加"运行"按钮
 * - 点击后调用宿主执行代码
 * - 显示执行结果
 */

export interface CodeRunResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export type CodeRunner = (
  code: string,
  language: 'javascript' | 'typescript' | 'python',
) => Promise<CodeRunResult>;

const RUNNABLE_LANGS = new Set(['javascript', 'js', 'typescript', 'ts', 'python', 'py']);

/** 判断代码块语言是否可运行 */
export function isRunnableLanguage(lang: string): boolean {
  return RUNNABLE_LANGS.has(lang.toLowerCase());
}

/** 获取标准化语言名 */
export function normalizeLanguage(lang: string): 'javascript' | 'typescript' | 'python' {
  const lower = lang.toLowerCase();
  if (lower === 'python' || lower === 'py') return 'python';
  if (lower === 'typescript' || lower === 'ts') return 'typescript';
  return 'javascript';
}

/** 在代码块上添加运行按钮 */
export function addRunButtonToCodeBlock(
  preElement: HTMLElement,
  code: string,
  language: string,
  runner: CodeRunner,
): void {
  if (!isRunnableLanguage(language)) return;
  if (preElement.querySelector('.ds-code-run-btn')) return;

  const btn = document.createElement('button');
  btn.className = 'ds-code-run-btn';
  btn.textContent = '运行';
  btn.style.cssText = 'position:absolute;top:4px;right:8px;padding:2px 8px;font-size:12px;background:#3370ff;color:#fff;border:none;border-radius:4px;cursor:pointer;';

  btn.addEventListener('click', async () => {
    btn.textContent = '运行中...';
    btn.disabled = true;
    try {
      const result = await runner(code, normalizeLanguage(language));
      const output = document.createElement('div');
      output.style.cssText = 'margin-top:8px;padding:8px;background:#f6f8fa;border-radius:4px;font-size:12px;white-space:pre-wrap;';
      if (result.ok) {
        output.textContent = result.stdout || 'OK';
        if (result.stderr) output.textContent += `\n[stderr]\n${result.stderr}`;
      } else {
        output.textContent = `错误: ${result.error ?? result.stderr ?? '未知错误'}`;
        output.style.color = '#e5484d';
      }
      preElement.parentElement?.appendChild(output);
    } catch (e) {
      btn.textContent = '失败';
      btn.disabled = false;
      return;
    }
    btn.textContent = '已运行';
  });

  preElement.style.position = 'relative';
  preElement.appendChild(btn);
}

/** 水合所有代码块（添加运行按钮） */
export function hydrateCodeBlocks(container: HTMLElement, runner: CodeRunner): void {
  const codeBlocks = container.querySelectorAll('pre');
  codeBlocks.forEach((pre) => {
    const code = pre.querySelector('code');
    if (!code) return;
    const lang = code.className.replace(/^language-/, '');
    addRunButtonToCodeBlock(pre as HTMLElement, code.textContent ?? '', lang, runner);
  });
}
