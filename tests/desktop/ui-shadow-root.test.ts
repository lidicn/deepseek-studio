import { describe, it, expect } from 'vitest';
import { createDisposerBag } from '../../src/ui/disposer';

describe('disposer', () => {
  it('createDisposerBag returns a function with add method', () => {
    const bag = createDisposerBag();
    expect(typeof bag).toBe('function');
    expect(typeof bag.add).toBe('function');
    expect(bag.disposed).toBe(false);
  });

  it('dispose executes fns in reverse order', () => {
    const bag = createDisposerBag();
    const order: string[] = [];
    bag.add(() => order.push('first'));
    bag.add(() => order.push('second'));
    bag.add(() => order.push('third'));
    bag();
    expect(order).toEqual(['third', 'second', 'first']);
    expect(bag.disposed).toBe(true);
  });

  it('dispose is idempotent', () => {
    const bag = createDisposerBag();
    let count = 0;
    bag.add(() => count++);
    bag();
    bag();
    expect(count).toBe(1);
  });

  it('add after dispose executes immediately', () => {
    const bag = createDisposerBag();
    bag();
    let count = 0;
    bag.add(() => count++);
    expect(count).toBe(1);
  });
});
