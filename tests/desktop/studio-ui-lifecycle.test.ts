import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/ui/studio-ui-core';

describe('EventBus lifecycle', () => {
  it('on/emit delivers payload to handlers', () => {
    const bus = new EventBus();
    let received: unknown = null;
    bus.on('test', (payload) => { received = payload; });
    bus.emit('test', 'hello');
    expect(received).toBe('hello');
  });

  it('unsubscribe stops delivery', () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on('test', () => { count++; });
    bus.emit('test', 1);
    off();
    bus.emit('test', 2);
    expect(count).toBe(1);
  });

  it('handlerCount returns total handlers', () => {
    const bus = new EventBus();
    bus.on('a', () => {});
    bus.on('a', () => {});
    bus.on('b', () => {});
    expect(bus.handlerCount()).toBe(3);
    expect(bus.handlerCount('a')).toBe(2);
  });

  it('clear removes all or specific event', () => {
    const bus = new EventBus();
    bus.on('a', () => {});
    bus.on('b', () => {});
    bus.clear('a');
    expect(bus.handlerCount()).toBe(1);
    bus.clear();
    expect(bus.handlerCount()).toBe(0);
  });
});
