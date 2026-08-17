import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const PORT = 5244, BASE = `http://127.0.0.1:${PORT}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js','--config','tools/vite.diag.config.js','--host','127.0.0.1','--port',String(PORT),'--strictPort'], { stdio:['ignore','pipe','pipe'] });
await new Promise((r,j)=>{const t=setTimeout(()=>j(new Error('timeout')),60000);vite.stdout.on('data',d=>{if(/ready in|Local:/i.test(String(d))){clearTimeout(t);r();}});});
const b = await chromium.launch({ headless:true, executablePath: process.env.PW_CHROME||undefined });
const p = await b.newPage();
await p.route(`${BASE}/__p.html`, r => r.fulfill({status:200,contentType:'text/html',body:'<!doctype html><meta charset=utf-8>'}));
await p.goto(`${BASE}/__p.html`);
const r = await p.evaluate(async (base) => {
  const nomes = ['tensaonoar','doidera','becoemchamas','radiacao','ruasemfogo'];
  const out = [];
  for (const n of nomes) {
    const a = new Audio(`${base}/audio/musica/${n}.mp3`);
    const res = await new Promise((ok) => {
      const t = setTimeout(() => ok({ erro: 'timeout' }), 20000);
      a.addEventListener('loadedmetadata', () => { clearTimeout(t); ok({ dur: +a.duration.toFixed(1) }); });
      a.addEventListener('error', () => { clearTimeout(t); ok({ erro: a.error?.message || 'erro' }); });
      a.load();
    });
    out.push({ nome: n, ...res });
  }
  return out;
}, BASE);
for (const f of r) console.log(f.erro ? `  FALHOU ${f.nome}: ${f.erro}` : `  ok  ${f.nome.padEnd(14)} ${f.dur}s`);
await b.close(); vite.kill();
process.exit(r.some(f=>f.erro) ? 1 : 0);
