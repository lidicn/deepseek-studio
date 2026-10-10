// B1 · 注入加载器
export * from './types';
export * from './origin-guard';
export * from './navigation';
export * from './loader';
// B2 · 同域直连桥（替代 postMessage，消除伪造面）
export * from './direct-target';
export * from './direct-port';
export * from './direct-bridge';
export * from './bridge-install';
