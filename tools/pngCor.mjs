/**
 * Le uma captura PNG e mede a cor de regioes dela. Serve para comparar a linha
 * de base antiga com a nova NO MESMO enquadramento, sem depender de rodar o
 * jogo de novo — e a unica forma honesta de dizer "antes/depois" quando as duas
 * fotos ja existem.
 *
 *   node tools/pngCor.mjs shots/a.png shots/b.png x0,y0,x1,y1 [mais caixas...]
 *
 * Sem caixas, imprime so o tamanho. Decodifica PNG na mao (zlib + desfiltro),
 * sem dependencia nova.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

function lerPNG(arq) {
  const b = readFileSync(arq);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(arq + ': nao e PNG');
  let i = 8, larg = 0, alt = 0, prof = 0, tipo = 0;
  const pedacos = [];
  while (i < b.length) {
    const n = b.readUInt32BE(i), nome = b.toString('ascii', i + 4, i + 8);
    const dados = b.subarray(i + 8, i + 8 + n);
    if (nome === 'IHDR') {
      larg = dados.readUInt32BE(0); alt = dados.readUInt32BE(4);
      prof = dados[8]; tipo = dados[9];
      if (prof !== 8 || (tipo !== 6 && tipo !== 2)) {
        throw new Error(`${arq}: so 8 bits RGB/RGBA (prof=${prof} tipo=${tipo})`);
      }
    } else if (nome === 'IDAT') pedacos.push(dados);
    else if (nome === 'IEND') break;
    i += 12 + n;
  }
  const canais = tipo === 6 ? 4 : 3;
  const cru = inflateSync(Buffer.concat(pedacos));
  const passo = larg * canais;
  const saida = Buffer.alloc(alt * passo);
  let o = 0;
  for (let y = 0; y < alt; y++) {
    const filtro = cru[o++];
    const lin = cru.subarray(o, o + passo); o += passo;
    const dst = saida.subarray(y * passo, (y + 1) * passo);
    const ant = y > 0 ? saida.subarray((y - 1) * passo, y * passo) : null;
    for (let x = 0; x < passo; x++) {
      const a = x >= canais ? dst[x - canais] : 0;
      const c = ant ? ant[x] : 0;
      const d = (ant && x >= canais) ? ant[x - canais] : 0;
      let v = lin[x];
      if (filtro === 1) v += a;
      else if (filtro === 2) v += c;
      else if (filtro === 3) v += (a + c) >> 1;
      else if (filtro === 4) {
        const p = a + c - d, pa = Math.abs(p - a), pb = Math.abs(p - c), pc = Math.abs(p - d);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? c : d);
      }
      dst[x] = v & 255;
    }
  }
  return { larg, alt, canais, dados: saida };
}

function medir(img, x0, y0, x1, y1) {
  const { larg, canais, dados } = img;
  let R = 0, G = 0, B = 0, n = 0; const L = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * larg + x) * canais;
    R += dados[i]; G += dados[i + 1]; B += dados[i + 2]; n++;
    L.push(0.2126 * dados[i] + 0.7152 * dados[i + 1] + 0.0722 * dados[i + 2]);
  }
  L.sort((a, b) => a - b);
  return {
    n, r: R / n, g: G / n, b: B / n,
    lum: (0.2126 * R + 0.7152 * G + 0.0722 * B) / n,
    med: L[L.length >> 1], frio: (B - R) / n,
  };
}

/** Grava um PNG RGB de 8 bits (sem filtro) — so para os recortes ampliados. */
function gravarPNG(arq, larg, alt, rgb) {
  const crc = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return (buf) => {
      let c = -1;
      for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 255] ^ (c >>> 8);
      return (c ^ -1) >>> 0;
    };
  })();
  const pedaco = (nome, dados) => {
    const n = Buffer.alloc(4); n.writeUInt32BE(dados.length);
    const corpo = Buffer.concat([Buffer.from(nome, 'ascii'), dados]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(corpo));
    return Buffer.concat([n, corpo, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(larg, 0); ihdr.writeUInt32BE(alt, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const cru = Buffer.alloc(alt * (larg * 3 + 1));
  for (let y = 0; y < alt; y++) {
    cru[y * (larg * 3 + 1)] = 0;
    rgb.copy(cru, y * (larg * 3 + 1) + 1, y * larg * 3, (y + 1) * larg * 3);
  }
  writeFileSync(arq, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pedaco('IHDR', ihdr), pedaco('IDAT', deflateSync(cru)), pedaco('IEND', Buffer.alloc(0)),
  ]));
}

/** Recorte ampliado por vizinho mais proximo: mostra o pixel como ele e. */
function recortar(img, x0, y0, w, h, k, saida) {
  const out = Buffer.alloc(w * k * h * k * 3);
  for (let y = 0; y < h * k; y++) for (let x = 0; x < w * k; x++) {
    const sx = x0 + Math.floor(x / k), sy = y0 + Math.floor(y / k);
    const s = (sy * img.larg + sx) * img.canais, d = (y * w * k + x) * 3;
    out[d] = img.dados[s]; out[d + 1] = img.dados[s + 1]; out[d + 2] = img.dados[s + 2];
  }
  gravarPNG(saida, w * k, h * k, out);
  console.log(`  recorte -> ${saida}  (${w}x${h} px ampliado ${k}x)`);
}

const args = process.argv.slice(2);
const rec = args.find((a) => a.startsWith('--recorte='));
if (rec) {
  // --recorte=x,y,w,h,escala,saida.png
  const [x, y, w, h, k, saida] = rec.slice(10).split(',');
  const alvo = args.find((a) => a.endsWith('.png') && a !== saida);
  recortar(lerPNG(alvo), +x, +y, +w, +h, +k, saida);
  process.exit(0);
}
/**
 * --ciano=x0,y0,x1,y1  : legibilidade da fenda numa janela.
 * Indice de ciano = (g+b)/2 - r no pixel FINAL. Acima de ~35 a cor le como
 * ciano a olho; abaixo de ~15 le como cinza claro.
 */
const cia = args.filter((a) => a.startsWith('--ciano='));
if (cia.length) {
  for (const arq of args.filter((a) => a.endsWith('.png'))) {
    const img = lerPNG(arq);
    console.log(arq);
    for (const c of cia) {
      const [x0, y0, x1, y1] = c.slice(8).split(',').map(Number);
      let mx = -999, px = 0, py = 0, n = 0, cor = [0, 0, 0];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = (y * img.larg + x) * img.canais;
        const R = img.dados[i], G = img.dados[i + 1], B = img.dados[i + 2];
        const ci = (G + B) / 2 - R;
        if (ci > 35) n++;
        if (ci > mx) { mx = ci; px = x; py = y; cor = [R, G, B]; }
      }
      console.log(`  janela ${String(x1 - x0 + 1).padStart(3)}x${String(y1 - y0 + 1).padStart(3)} em (${x0},${y0})`
        + `  pico de ciano = ${mx.toFixed(1).padStart(6)} em (${px},${py}) rgb(${cor.join(',')})`
        + `  ·  pixels com ciano>35: ${n}`);
    }
  }
  process.exit(0);
}

const arqs = args.filter((a) => a.endsWith('.png'));
const caixas = args.filter((a) => /^\d+,\d+,\d+,\d+$/.test(a)).map((a) => a.split(',').map(Number));
const imgs = arqs.map((a) => ({ nome: a, img: lerPNG(a) }));
for (const { nome, img } of imgs) console.log(`${nome}  ${img.larg}x${img.alt}  ${img.canais} canais`);
if (!caixas.length) process.exit(0);

console.log('\ncaixa                  arquivo                       rgb medio            lum   mediana  frio(b-r)');
for (const c of caixas) {
  for (const { nome, img } of imgs) {
    const m = medir(img, c[0], c[1], c[2], c[3]);
    console.log(
      `${c.join(',').padEnd(22)} ${nome.replace(/^shots[\\/]/, '').padEnd(28)} `
      + `(${m.r.toFixed(0).padStart(3)},${m.g.toFixed(0).padStart(3)},${m.b.toFixed(0).padStart(3)})  `
      + `${m.lum.toFixed(1).padStart(6)}  ${m.med.toFixed(1).padStart(6)}  ${m.frio.toFixed(1).padStart(6)}`,
    );
  }
  console.log('');
}
