import { chromium } from 'playwright';
const modos = [
  ['headless-swift', true, ['--use-angle=default','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']],
  ['headless-gpu',   true, ['--use-angle=d3d11','--ignore-gpu-blocklist','--enable-gpu']],
  ['headed-gpu',     false, ['--use-angle=d3d11','--ignore-gpu-blocklist']],
];
for (const [nome, hl, args] of modos) {
  try {
    const b = await chromium.launch({ headless: hl, args });
    const p = await b.newPage();
    await p.setContent('<canvas id=c></canvas>');
    const r = await p.evaluate(() => {
      const gl = document.getElementById('c').getContext('webgl2');
      if (!gl) return 'sem webgl2';
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      return (e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
        + ' | KHR_parallel_shader_compile=' + !!gl.getExtension('KHR_parallel_shader_compile');
    });
    console.log(nome.padEnd(16), r);
    await b.close();
  } catch (e) { console.log(nome.padEnd(16), 'FALHOU', String(e).split('\n')[0]); }
}
