// Config do vite SO para os scripts de diagnostico em tools/: desliga HMR e
// ignora pastas de saida, para a pagina nunca recarregar no meio de uma medicao.
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    hmr: false,
    watch: { ignored: ['**/shots/**', '**/tools/**', '**/test/**'] },
  },
  optimizeDeps: { include: ['three'] },
  build: { target: 'esnext', sourcemap: false, chunkSizeWarningLimit: 4096 },
  assetsInclude: ['**/*.glsl', '**/*.hdr', '**/*.bin'],
});
