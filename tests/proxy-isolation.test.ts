/** 验证代理模块导入与构造不会覆盖宿主 dispatcher；子进程隔离且不发网络请求。 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

function probeProxyImport(configureProxy: boolean): unknown {
  const moduleUrl = new URL('../src/bridge/proxy.ts', import.meta.url).href
  const script = `
    const key = Symbol.for('undici.globalDispatcher.1');
    const dispatcher = { dispatch() { throw new Error('network access forbidden'); } };
    globalThis[key] = dispatcher;
    const originalFetch = globalThis.fetch;
    const proxy = await import(${JSON.stringify(moduleUrl)});
    if (${configureProxy}) proxy.createEnvProxyFetch({ https_proxy: 'http://127.0.0.1:9' });
    console.log(JSON.stringify({ sameDispatcher: globalThis[key] === dispatcher, sameFetch: globalThis.fetch === originalFetch }));
  `
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '', NODE_USE_ENV_PROXY: '0' },
  })
  expect(child.error).toBeUndefined()
  expect(child.status, child.stderr).toBe(0)
  return JSON.parse(child.stdout) as unknown
}

describe('proxy process isolation', () => {
  it.each([false, true])('preserves host dispatcher and fetch (configureProxy=%s)', (configureProxy) => {
    expect(probeProxyImport(configureProxy)).toEqual({ sameDispatcher: true, sameFetch: true })
  })
})
