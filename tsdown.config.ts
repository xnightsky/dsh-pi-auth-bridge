/**
 * tsdown 构建：浏览器半区（dist/client.js）。
 *
 * 产物是 dsh web 的 CJS 懒加载模块表：外包 `window.__ModuleLoader__.load`
 * 包装，宿主经 `/plugins/<id>/client.js` 供浏览器加载，首次 require 才执行。
 * react 由宿主模块加载器提供（external）；zod 与 Typert 产物内联（官方
 * client 产物同样内联 zod，模块加载器不保证提供它）。
 *
 * host 半区与 Typert 产物（typert.host/remote-client）仍由 tsc 按文件产出，
 * 见 package.json 的 build 脚本。
 */
import { defineConfig } from 'tsdown'

const CLIENT_ID = 'dsh-pi-auth-bridge'

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'dist',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  clean: false,
  dts: false,
  sourcemap: true,
  deps: {
    neverBundle: ['react', 'react/jsx-runtime'],
    alwaysBundle: ['zod'],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
