import { toText, truncateText } from '../escape';
import type { VisComponentRenderer } from './../registry';

function variantClass(variant: unknown): string {
  switch (variant) {
    case 'title': return 'ds-studio-vis-text--title';
    case 'subtitle': return 'ds-studio-vis-text--subtitle';
    case 'meta': return 'ds-studio-vis-text--meta';
    default: return 'ds-studio-vis-text--body';
  }
}

export const textRenderer: VisComponentRenderer = {
  type: 'Text',
  allowsChildren: false,
  render(props, ctx) {
    const body = ctx.escape(truncateText(toText(props.text)));
    return `<div class="ds-studio-vis-text ${variantClass(props.variant)}">${body}</div>`;
  },
};
