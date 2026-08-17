import { defineConfig } from 'vite';

export default defineConfig({
  /* Base relativa: o build funciona tanto na raiz de um dominio quanto numa
   * subpasta, que e como o GitHub Pages serve um repositorio comum
   * (https://usuario.github.io/nome-do-repo/). Com base absoluta '/' todo
   * asset daria 404 la. Em JS, use `import.meta.env.BASE_URL` — o Vite
   * reescreve caminho em HTML e CSS, mas nao dentro de string de JS. */
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { target: 'esnext', sourcemap: false, chunkSizeWarningLimit: 4096 },
  // Shaders e assets binarios
  assetsInclude: ['**/*.glsl', '**/*.hdr', '**/*.bin'],
});
