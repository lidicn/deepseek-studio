import { describe, it, expect } from 'vitest';
import { color, space, radius, zLayer, tokensToCssVars } from '../../src/ui/design-tokens';

describe('design-tokens', () => {
  it('has light and dark color palettes', () => {
    expect(color.light.bgPage).toBe('#F7F8FA');
    expect(color.dark.bgPage).toBe('#111318');
  });

  it('has spacing scale', () => {
    expect(space.xs).toBe(4);
    expect(space.xl).toBe(24);
  });

  it('has radius scale', () => {
    expect(radius.md).toBe(8);
    expect(radius.xl).toBe(16);
  });

  it('has z-layer scale', () => {
    expect(zLayer.dialog).toBe(40);
    expect(zLayer.tooltip).toBe(60);
  });

  it('tokensToCssVars returns valid CSS variables string', () => {
    const css = tokensToCssVars('light');
    expect(css).toContain('--studio-bg-page');
    expect(css).toContain('#F7F8FA');
  });
});
