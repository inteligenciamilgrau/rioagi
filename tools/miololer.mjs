/**
 * miololer.mjs — le um dump do `miolo.mjs` e responde perguntas novas SEM
 * pagar outra corrida de 5 minutos. Corrida e cara e a bancada e ruidosa;
 * re-analisar o mesmo dump e a unica forma honesta de comparar hipoteses.
 *
 *   node tools/miololer.mjs [tag] [trecho]
 */
import { readFileSync } from 'node:fs';
const TAG = process.argv[2] ?? 'antes';
const D = JSON.parse(readFileSync('tools/miolo.' + TAG + '.json', 'utf8'));
const { Q, ordem: ORD, marcos } = D;
const NF = ORD.length, BASE = 17;
const col = { t: 0, dt: 1, aiTot: 2, heap: 3, vivos: 4, drones: 5, atirando: 6, ragd: 7, longe: 8, prog: 9, busca: 10, nos: 11, cacheHit: 12, falha: 13, rc: 14, sc: 15, cs: 16 };
const iMS = (q, n) => q[BASE + ORD.indexOf(n)];
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const n2 = (x) => (isFinite(x) ? x.toFixed(2) : '-');

const ms = marcos.filter((m) => m.nome !== 'gravacao-comeca');
const trechos = [];
for (let i = 0; i < ms.length; i++) {
  const a = ms[i].q, b = i + 1 < ms.length ? ms[i + 1].q : Q.length;
  if (b - a > 30) trechos.push({ nome: ms[i].nome, a: a + 20, b });
}
const so = process.argv[3];

// sistemas de primeiro nivel: os que nao rodam dentro de outro
const TOPO = ['ai', 'player', 'fx', 'audio', 'render'].filter((n) => ORD.includes(n));

for (const tr of trechos) {
  if (so && !tr.nome.includes(so)) continue;
  const S = Q.slice(tr.a, tr.b);
  console.log('');
  console.log('== ' + tr.nome + '  (' + S.length + ' quadros, ' + (S.reduce((a,q)=>a+q[col.vivos],0)/S.length).toFixed(1) + ' vivos)');
  console.log('   sistema     p50     p90     p99    p99.9    PIOR');
  const soma = (q) => { let x = 0; for (const f of ORD) x += iMS(q, f); return x; };
  const linhas = [];
  for (const f of TOPO) {
    // topo: inclusivo = exclusivo + filhos; para os de topo uso a soma das
    // fases que rodam dentro deles quando conheco (so `ai`), senao exclusivo.
    const v = f === 'ai' ? S.map((q) => q[col.aiTot]) : S.map((q) => iMS(q, f));
    linhas.push([f, v]);
  }
  linhas.push(['CPU-total', S.map(soma)]);
  linhas.push(['fora', S.map((q) => q[col.dt] - soma(q))]);
  linhas.push(['dt', S.map((q) => q[col.dt])]);
  for (const [f, v] of linhas) {
    console.log('   ' + f.padEnd(11) + n2(pct(v, 0.5)).padStart(7) + n2(pct(v, 0.9)).padStart(8)
      + n2(pct(v, 0.99)).padStart(8) + n2(pct(v, 0.999)).padStart(8) + n2(Math.max(...v)).padStart(9));
  }
  // quadros ruins SEM ruido de maquina: fora < 5 ms
  const limpos = S.filter((q) => (q[col.dt] - soma(q)) < 5);
  const dtL = limpos.map((q) => q[col.dt]);
  console.log('   --- so quadros com `fora` < 5 ms (' + limpos.length + '/' + S.length + ', sem hiato de maquina):');
  console.log('   ' + 'dt limpo'.padEnd(11) + n2(pct(dtL, 0.5)).padStart(7) + n2(pct(dtL, 0.9)).padStart(8)
    + n2(pct(dtL, 0.99)).padStart(8) + n2(pct(dtL, 0.999)).padStart(8) + n2(Math.max(...dtL)).padStart(9));
  const cpuL = limpos.map(soma);
  console.log('   ' + 'cpu limpo'.padEnd(11) + n2(pct(cpuL, 0.5)).padStart(7) + n2(pct(cpuL, 0.9)).padStart(8)
    + n2(pct(cpuL, 0.99)).padStart(8) + n2(pct(cpuL, 0.999)).padStart(8) + n2(Math.max(...cpuL)).padStart(9));
  const aiL = limpos.map((q) => q[col.aiTot]);
  console.log('   ' + 'ai limpo'.padEnd(11) + n2(pct(aiL, 0.5)).padStart(7) + n2(pct(aiL, 0.9)).padStart(8)
    + n2(pct(aiL, 0.99)).padStart(8) + n2(pct(aiL, 0.999)).padStart(8) + n2(Math.max(...aiL)).padStart(9));
  const rendL = limpos.map((q) => iMS(q, 'render'));
  console.log('   ' + 'render limpo'.padEnd(11) + n2(pct(rendL, 0.5)).padStart(6) + n2(pct(rendL, 0.9)).padStart(8)
    + n2(pct(rendL, 0.99)).padStart(8) + n2(pct(rendL, 0.999)).padStart(8) + n2(Math.max(...rendL)).padStart(9));
  const rr = S.map((q) => q[col.rc] + q[col.sc] + q[col.cs]);
  console.log('   raios/quadro: p50 ' + pct(rr, 0.5) + ' p99 ' + pct(rr, 0.99) + ' max ' + Math.max(...rr));
}
