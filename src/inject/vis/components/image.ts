import { isRecord, toText } from '../escape';
import { DEFAULT_HUE, noteOutcome } from '../types';
import type { VisComponentRenderer } from './../registry';

function ratioClass(ratio: unknown): string {
  if (ratio === '2/3') return 'ds-studio-vis-ratio-2x3';
  if (ratio === '16/9') return 'ds-studio-vis-ratio-16x9';
  return '';
}

/** hue 归一化为 [0,360] 整数；非有限数回落默认值，杜绝样式串注入。 */
function normalizeHue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_HUE;
  return Math.min(360, Math.max(0, Math.round(value)));
}

export const imageRenderer: VisComponentRenderer = {
  type: 'Image',
  allowsChildren: false,
  render(props, ctx) {
    const alt = toText(props.alt);
    const ratio = ratioClass(props.ratio);
    const cls = ratio === '' ? 'ds-studio-vis-img' : `ds-studio-vis-img ${ratio}`;
    const fallback = isRecord(props.fallback) ? props.fallback : null;
    const hue = normalizeHue(fallback === null ? undefined : fallback.hue);
    const resolved = ctx.imageResolver.resolve(props.src);
    if (resolved.src !== null) {
      // 必须 eager：宿主 WebView + DeepSeek 虚拟滚动容器里，lazy 的可见性判定会失效，
      // 图片既不发起请求、也不触发 error，海报框会永久空白。async 只解码，不影响拉取。
      // hue 同时挂在 img 上，加载失败替换占位时才能延续配色。
      // no-referrer 是有意为之：不少图床按 Referer 判防盗链，不带反而更宽松。
      // 但要清楚它救不了豆瓣：img*.doubanio.com 无 Referer 仍可能 418 或返回反爬 HTML。
      return (
        `<img class="${cls}" src="${ctx.escape(resolved.src)}" alt="${ctx.escape(alt)}"` +
        ` loading="eager" decoding="async" referrerpolicy="no-referrer"` +
        ` style="--ds-studio-vis-hue:${hue}">`
      );
    }
    // 语义区分：模型**没给图**（src=null）是 PoC 的设计内状态 → 渐变占位，**不算降级**；
    // 只有**协议被拒**（javascript:/data:/ftp: 等）才是安全降级，需要进 outcome。
    if (resolved.reason === 'image_unsafe_src') noteOutcome(ctx.outcome, 'degraded', resolved.reason);
    return (
      `<div class="${cls} ds-studio-vis-img--placeholder" style="--ds-studio-vis-hue:${hue}"` +
      ` role="img" aria-label="${ctx.escape(alt)}"><span class="ds-studio-vis-img__alt">${ctx.escape(alt)}</span></div>`
    );
  },
};
