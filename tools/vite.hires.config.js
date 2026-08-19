// Config do vite para medicao de TEMPO FINO (tools/miolo.mjs).
//
// Igual ao vite.diag.config.js, mais os dois cabecalhos que ligam o
// isolamento de origem cruzada. Sem eles o Chrome grosseiriza
// `performance.now()` em 100 us — e uma fase de IA que custa 40 us le como
// 0,0 ou 0,1 ms conforme o arredondamento, com erro somado por CHAMADA (sao
// mais de 100 por quadro). Com `crossOriginIsolated === true` a resolucao vai
// para 5 us e a quebra do `ai.update` por sub-sistema passa a significar algo.
//
// Tudo no projeto e same-origin e procedural (nao ha asset externo), entao
// `require-corp` nao quebra nada.
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    hmr: false,
    watch: { ignored: ['**/shots/**', '**/tools/**', '**/test/**'] },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  },
  optimizeDeps: { include: ['three'] },
  build: { target: 'esnext', sourcemap: false, chunkSizeWarningLimit: 4096 },
  assetsInclude: ['**/*.glsl', '**/*.hdr', '**/*.bin'],
});
