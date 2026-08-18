import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// O projeto e ESM ("type": "module"), entao __dirname nao existe de graca.
const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  /* Base relativa: o build funciona tanto na raiz de um dominio quanto numa
   * subpasta, que e como o GitHub Pages serve um repositorio comum
   * (https://usuario.github.io/nome-do-repo/). Com base absoluta '/' todo
   * asset daria 404 la. Em JS, use `import.meta.env.BASE_URL` — o Vite
   * reescreve caminho em HTML e CSS, mas nao dentro de string de JS. */
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    /* DUAS paginas. Sem declarar aqui, o Vite constroi so o `index.html` e
     * qualquer outra pagina simplesmente NAO EXISTE no site publicado — foi o
     * que acontecia com as paginas de `test/`, que so funcionavam em
     * desenvolvimento. Ao acrescentar pagina, acrescente a entrada aqui. */
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        world: resolve(__dirname, 'world.html'),
      },
    },
  },
  // Shaders e assets binarios
  assetsInclude: ['**/*.glsl', '**/*.hdr', '**/*.bin'],
});
