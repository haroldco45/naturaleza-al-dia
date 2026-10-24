// Robot de Naturaleza al Día — trae de wwf.org.co noticias, fotos y videos reales,
// y los deja en español e inglés. Corre en GitHub Actions cada 30 minutos. Sin dependencias (Node 20+).
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';

const OUT = 'data/noticias.json';
const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache', 'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1'
};
const BASE = 'https://www.wwf.org.co';
const AHORA = new Date();

// ---------- utilidades ----------
const MESES = { ene:0, jan:0, feb:1, mar:2, abr:3, apr:3, may:4, jun:5, jul:6, ago:7, aug:7, sep:8, set:8, oct:9, nov:10, dic:11, dec:11 };
const ENT = { nbsp:' ', amp:'&', quot:'"', apos:"'", lt:'<', gt:'>', aacute:'á', eacute:'é', iacute:'í', oacute:'ó', uacute:'ú', ntilde:'ñ', Aacute:'Á', Eacute:'É', Iacute:'Í', Oacute:'Ó', Uacute:'Ú', Ntilde:'Ñ', uuml:'ü', iquest:'¿', iexcl:'¡', laquo:'«', raquo:'»', ldquo:'“', rdquo:'”', lsquo:'‘', rsquo:'’', ndash:'–', mdash:'—', hellip:'…', copy:'©' };
const deco = s => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n] ?? m);
const strip = s => deco(String(s || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
const clave = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);
const espera = ms => new Promise(r => setTimeout(r, ms));

function fechaES(t) {
  const m = String(t).match(/(\d{1,2})\s+([A-Za-zé]{3})[a-zé]*\.?\s+(?:de\s+)?(\d{4})/);
  if (!m) return null;
  const mm = MESES[m[2].toLowerCase().slice(0, 3)];
  return mm == null ? null : new Date(Date.UTC(+m[3], mm, +m[1], 17)).toISOString(); // mediodía en Bogotá
}
async function directo(url, ms = 20000, extra = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { ...UA, ...extra }, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
// Si el sitio bloquea a GitHub, se intenta por rutas de respaldo
const ORIGEN = 'https://originlaccms1.wwf-sites.org:8301';
function conCurl(url, ms = 20000) {
  const h = Object.entries(UA).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
  return new Promise((ok, mal) => execFile('curl', ['-sSL', '--compressed', '--http2', '-m', String(Math.round(ms / 1000)), '-w', '\\n%{http_code}', ...h, url], { maxBuffer: 20e6 }, (e, out) => {
    if (e) return mal(e);
    const i = out.lastIndexOf('\n'); const code = +out.slice(i + 1);
    code >= 200 && code < 400 ? ok(out.slice(0, i)) : mal(new Error('curl HTTP ' + code));
  }));
}
const RESPALDOS = [
  u => /wwf\.org\.co/.test(u) ? [u.replace(/^https?:\/\/(www\.)?wwf\.org\.co/, ORIGEN), {}] : null,
  u => ['curl:' + u, {}],
  u => ['https://api.allorigins.win/raw?url=' + encodeURIComponent(u), {}],
  u => ['https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u), {}],
  u => ['https://r.jina.ai/' + u, { 'X-Return-Format': 'html', 'Accept': 'text/html' }]
];
const via = {};
const INICIO = Date.now();
const tiempo = () => (Date.now() - INICIO) / 1000;      // segundos desde que arrancó
const LIMITE = 8 * 60;                                   // el robot no pasa de 8 minutos
const ruta = {};                                         // por sitio: 'directo', índice de respaldo o 'caido'
async function traer(url, ms = 15000) {
  const host = new URL(url).host;
  const permiteRespaldo = /wwf\.org\.co|youtube\.com/.test(url);
  if (ruta[host] === 'caido') throw new Error('sitio no disponible en esta corrida');
  if (ruta[host] === undefined || ruta[host] === 'directo') {
    try { const x = await directo(url, ms); ruta[host] = 'directo'; via[host] = 'directo'; return x; }
    catch (e) { if (!permiteRespaldo || ruta[host] === 'directo') throw e; }
  }
  const orden = typeof ruta[host] === 'number' ? [ruta[host]] : RESPALDOS.map((_, i) => i);
  for (const i of orden) {
    try {
      const r = RESPALDOS[i](url); if (!r) continue;
      const [u2, h] = r; const x = u2.startsWith('curl:') ? await conCurl(url) : await directo(u2, 20000, h);
      if (x && x.length > 500 && !/Just a moment|Access denied|403 Forbidden/i.test(x.slice(0, 3000))) { ruta[host] = i; via[host] = u2.startsWith('curl:') ? 'curl' : new URL(u2).host; return x; }
    } catch {}
  }
  if (typeof ruta[host] !== 'number') ruta[host] = 'caido';
  throw new Error('bloqueado y sin respaldo');
}

const absoluto = href => {
  href = deco(href).trim().split(/\s+/)[0];
  if (!href) return '';
  href = href.replace(/^https?:\/\/originlaccms1\.wwf-sites\.org(:\d+)?/i, BASE);
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('http')) return href;
  if (href.startsWith('?')) return BASE + '/' + href;
  return BASE + (href.startsWith('/') ? '' : '/') + href;
};
const meta = (html, prop) => {
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
  return a ? deco(a[1]).trim() : '';
};

// ---------- fotos y videos de una página de WWF ----------
const FOTO_OK = u => /\.(jpe?g|png|webp)(\?|$)/i.test(u) && !/logo|icon|sprite|ajax-loader|_skins|pixel|blank|avatar|flag/i.test(u);
export function fotosDe(html) {
  const out = []; const vistos = new Set();
  const re = /<img\b[^>]*>/gi; let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const src = (tag.match(/\bdata-src=["']([^"']+)["']/i) || tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1];
    if (!src) continue;
    const url = absoluto(src);
    if (!FOTO_OK(url) || vistos.has(url)) continue;
    vistos.add(url);
    const alt = deco((tag.match(/\balt=["']([^"']*)["']/i) || [])[1] || '').trim();
    const despues = html.slice(m.index + tag.length, m.index + tag.length + 700).split(/<img\b/i)[0];
    const antes = html.slice(Math.max(0, m.index - 300), m.index);
    const crs = [...antes.matchAll(/(?:©|&copy;)\s*([^<\n]{2,80})/g)];
    const cr = despues.match(/(?:©|&copy;)\s*([^<\n]{2,80})/) || crs[crs.length - 1];
    out.push({ img: url, credito: cr ? '© ' + strip(cr[1]).replace(/^©\s*/, '') : '© WWF', alt });
  }
  // fondos por CSS
  for (const b of html.matchAll(/background(?:-image)?\s*:\s*url\(['"]?([^'")]+)['"]?\)/gi)) {
    const url = absoluto(b[1]);
    if (FOTO_OK(url) && !vistos.has(url)) { vistos.add(url); out.push({ img: url, credito: '© WWF', alt: '' }); }
  }
  return out;
}
export function videosDe(html) {
  const ids = new Set();
  for (const m of html.matchAll(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/g)) ids.add(m[1]);
  return [...ids];
}

// ---------- 1) Noticias de las páginas de wwf.org.co ----------
export function parseWWF(html) {
  const items = new Map();
  const re = /<a\b[^>]*href="([^"]*\?(\d{5,7})(?:%2F|\/)([^"]*))"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const [, href, id, , inner] = m;
    let titulo = '', resumen = '', imagen = '', credito = '';
    const fuerte = inner.match(/<(strong|b|h[1-6])[^>]*>([\s\S]*?)<\/\1>/i);
    const texto = strip(inner);
    const fecha = fechaES(texto);
    const f1 = fotosDe(inner)[0];
    if (f1) { imagen = f1.img; credito = f1.credito; }
    const cr = texto.match(/©\s*([^©]{2,60}?)(?=\s+\d{1,2}\s+\w{3}\s+\d{4}|\s{2}|$)/);
    if (cr && !credito) credito = '© ' + cr[1].trim();
    if (fuerte) { titulo = strip(fuerte[2]); resumen = texto.split(titulo).slice(1).join(' ').trim(); }
    let destacada = false;
    if (!titulo || titulo.length < 15) {
      destacada = true;
      const antes = html.slice(Math.max(0, m.index - 2500), m.index);
      const hs = [...antes.matchAll(/<(h[1-6]|strong)[^>]*>([\s\S]*?)<\/\1>/gi)];
      const h = hs.length ? hs[hs.length - 1] : null;
      if (h) {
        titulo = strip(h[2]);
        const despues = antes.slice(antes.lastIndexOf(h[0]) + h[0].length);
        const p = despues.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        resumen = p ? strip(p[1]) : strip(despues).slice(0, 300);
        const fs_ = fotosDe(antes.slice(-2000));
        if (fs_.length && !imagen) { imagen = fs_[fs_.length - 1].img; credito = fs_[fs_.length - 1].credito; }
        const crd = html.slice(m.index, m.index + 600).match(/©\s*([^<\n]{2,60})/);
        if (crd) credito = '© ' + strip(crd[1]);
      }
    }
    if (!titulo || titulo.length < 12) continue;
    resumen = resumen.replace(/^©[^A-ZÁÉÍÓÚ¿¡]*/, '').replace(/\s*\d{1,2}\s+\w{3}\s+\d{4}\s*/, ' ').trim();
    if (resumen.length > 280) resumen = resumen.slice(0, 277).trim() + '…';
    const previo = items.get(id) || {};
    items.set(id, {
      id: 'wwf-' + id,
      titulo: previo.titulo && previo.titulo.length >= titulo.length ? previo.titulo : titulo,
      resumen: (previo.resumen || '').length >= resumen.length ? previo.resumen : resumen,
      fecha: previo.fecha || fecha,
      imagen: previo.imagen || imagen, credito: previo.credito || credito,
      enlace: absoluto(href), fuente: 'WWF Colombia', tipo: 'wwf',
      destacada: previo.destacada || destacada
    });
  }
  return [...items.values()];
}

// ---------- 2) RSS ----------
export function parseRSS(xml, tipo) {
  const out = [];
  for (const it of xml.match(/<item\b[\s\S]*?<\/item>/gi) || []) {
    const tag = n => { const x = it.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)<\\/${n}>`, 'i')); return x ? x[1] : ''; };
    let titulo = strip(tag('title'));
    let enlace = strip(tag('link')) || (it.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    const real = enlace.match(/[?&]url=([^&]+)/); if (/bing\.com/.test(enlace) && real) enlace = decodeURIComponent(real[1]);
    const pub = strip(tag('pubDate'));
    const bingFuente = strip((it.match(/<News:Source>([\s\S]*?)<\/News:Source>/i) || [])[1] || '');
    const fuente = strip(tag('source')) || bingFuente || (tipo === 'wwf' ? 'WWF Colombia' : 'Prensa');
    if (tipo === 'prensa' && titulo.endsWith(' - ' + fuente)) titulo = titulo.slice(0, -(fuente.length + 3));
    let resumen = tipo === 'prensa' ? '' : strip(tag('description'));
    if (resumen.length > 280) resumen = resumen.slice(0, 277) + '…';
    const fecha = pub && !isNaN(Date.parse(pub)) ? new Date(pub).toISOString() : null;
    let img = (it.match(/<(?:enclosure|media:content|media:thumbnail)[^>]+url="([^"]+)"/i) || [])[1] || '';
    const bingImg = it.match(/<News:Image>([^<]+)<\/News:Image>/i);
    if (!img && bingImg) img = deco(bingImg[1]).replace(/^http:/, 'https:');
    if (!titulo || !enlace) continue;
    const idm = enlace.match(/\?(\d{5,7})(?:%2F|\/)/);
    out.push({ id: idm ? 'wwf-' + idm[1] : tipo + '-' + hash(enlace), titulo, resumen, fecha, imagen: img, credito: img ? '© ' + fuente : '', enlace, fuente, tipo, destacada: false });
  }
  return out;
}

// ---------- 3) YouTube de WWF Colombia (enlazado desde wwf.org.co) ----------
const LISTA_WWF = 'PLDSAZA2y4sU56U9pfD78b8LtDDADX7m8z'; // "WWF COLOMBIA IN ENGLISH", de su canal
async function videosCanal() {
  let delaLista = [];
  try {
    const xml = await traer('https://www.youtube.com/feeds/videos.xml?playlist_id=' + LISTA_WWF);
    delaLista = leerFeed(xml);
    const id = (xml.match(/<yt:channelId>(UC[\w-]{22})<\/yt:channelId>/) || [])[1];
    if (id) { const todos = leerFeed(await traer('https://www.youtube.com/feeds/videos.xml?channel_id=' + id)); if (todos.length) return [...todos, ...delaLista]; }
  } catch (e) { console.log('lista YouTube:', e.message); }
  if (delaLista.length) return delaLista;
  for (const f of ['https://www.youtube.com/feeds/videos.xml?user=wwfcolombia', 'https://www.youtube.com/feeds/videos.xml?user=WWFColombia']) {
    try { const xml = await traer(f); const v = leerFeed(xml); if (v.length) return v; } catch {}
  }
  let canal = '';
  for (const u of ['https://www.youtube.com/wwfcolombia', 'https://www.youtube.com/@WWFColombia', 'https://www.youtube.com/user/wwfcolombia']) {
    try {
      const h = await traer(u);
      canal = (h.match(/"(?:channelId|externalId)":"(UC[\w-]{22})"/) || h.match(/channel\/(UC[\w-]{22})/) || [])[1] || '';
      if (canal) break;
    } catch {}
  }
  if (!canal) throw new Error('no encontré el canal');
  return leerFeed(await traer('https://www.youtube.com/feeds/videos.xml?channel_id=' + canal));
}
function leerFeed(xml) {
  return (xml.match(/<entry>[\s\S]*?<\/entry>/g) || []).map(e => ({
    id: (e.match(/<yt:videoId>([^<]+)/) || [])[1],
    titulo: strip((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1]),
    resumen: strip((e.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1]).slice(0, 220),
    fecha: (e.match(/<published>([^<]+)/) || [])[1] || null,
    canal: 'WWF Colombia'
  })).filter(v => v.id);
}

// ---------- 4) Traducción automática al inglés (con memoria) ----------
let errorTraduccion = ''; let fallosTraduccion = 0;
async function aIngles(texto) {
  if (!texto) return '';
  try {
    const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=es&tl=en&dt=t&q=' + encodeURIComponent(texto.slice(0, 1500));
    const j = JSON.parse(await directo(u, 12000, { Accept: 'application/json' }));
    const out = (j[0] || []).map(p => p[0]).join('').trim();
    if (out) return out;
  } catch (e) { errorTraduccion = 'google: ' + e.message; }
  const u2 = 'https://api.mymemory.translated.net/get?langpair=es|en&q=' + encodeURIComponent(texto.slice(0, 480));
  const j2 = JSON.parse(await directo(u2, 12000, { Accept: 'application/json' }));
  const out2 = (j2.responseData || {}).translatedText || '';
  if (!out2 || /MYMEMORY WARNING/i.test(out2)) throw new Error('sin traducción');
  return out2;
}
let traducciones = 0;
async function traducir(obj, campos, previo) {
  for (const c of campos) {
    const en = c + '_en';
    if (!obj[c]) { obj[en] = ''; continue; }
    if (previo && previo[c] === obj[c] && previo[en]) { obj[en] = previo[en]; continue; }
    if (traducciones >= 120 || tiempo() > LIMITE || fallosTraduccion >= 3) continue;
    try { obj[en] = await aIngles(obj[c]); traducciones++; await espera(250); } catch (e) { fallosTraduccion++; errorTraduccion = errorTraduccion || e.message; }
  }
}

// ---------- páginas fijas de las que se sacan fotos ----------
const PAGINAS = {
  amazonia: '/_donde_trabajamos_/amazonas/', andes: '/_donde_trabajamos_/andes/', orinoquia: '/_donde_trabajamos_/orinoquia/', pacifico: '/_donde_trabajamos_/pacifico/',
  bosques: '/que_hacemos/bosques/', especies: '/que_hacemos/especies/', clima: '/que_hacemos/cambio_climatico_y_energia/', oceanos: '/que_hacemos/oceanos/',
  alimentos: '/que_hacemos/alimentos/', agua: '/que_hacemos/agua/', comunidades: '/que_hacemos/comunidades_/', plasticos: '/que_hacemos/plasticos/',
  jovenes: '/que_hacemos/jovenes/', wwfclima: '/que_hacemos/wwf_al_clima/', corporativo: '/que_hacemos/corporativo/', areas: '/que_hacemos/areas_protegidas/',
  picachos: '/expediciones_/expedicion_picachos/', guaviare: '/expediciones_/expedicion_guaviare/', planetavivo: '/de_interes/informe_planeta_vivo/',
  congreso: '/de_interes/balance_del_congreso_2022_2026/', elecciones: '/de_interes/elecciones-colombia-2026/', climateweek: '/de_interes/climate_week_medellin_2026/',
  horaplaneta: '/de_interes/la_hora_del_planeta/', publicaciones: '/de_interes/publicaciones/', dona: '/_como_ayudar_/dona/', adopta: '/_como_ayudar_/adopta_una_especie/',
  pandamarket: '/_como_ayudar_/panda_market/', suscribete: '/_como_ayudar_/suscribete/'
};

async function main() {
  let previo = { wwf: [], prensa: [], videos: [], media: {} };
  try { previo = { ...previo, ...JSON.parse(await fs.readFile(OUT, 'utf8')) }; } catch {}
  const estado = {};
  const nuevos = { wwf: [], prensa: [] };
  let fotoGenerica = '';

  // Noticias
  const FUENTES = [
    ['wwfInicio', BASE + '/', 'wwf', h => { fotoGenerica = meta(h, 'og:image'); estado.fotosInicio = fotosDe(h).length; galeria.push(...fotosDe(h).map(f => ({ ...f, pagina: BASE + '/' }))); videosSueltos.push(...videosDe(h)); return parseWWF(h); }],
    ['wwfNoticias', BASE + '/de_interes/noticias/', 'wwf', parseWWF],
    ['wwfRSS', BASE + '/_template/_international/article/rss-feed.cfm?rss_xnav_id=203732&rss_obj_id=1632248&rss_lang_id=4&rss_xsite_id=1015&rss_language=es&rss_adminMode=false&rss_ArchiveMode=false', 'wwf', x => parseRSS(x, 'wwf')],
    ['prensa', 'https://news.google.com/rss/search?q=%22WWF%22+Colombia+when:30d&hl=es-419&gl=CO&ceid=CO:es-419', 'prensa', x => parseRSS(x, 'prensa')],
    ['prensaBing', 'https://www.bing.com/news/search?q=%22WWF%22+Colombia&format=rss&setlang=es-CO&cc=CO', 'prensa', x => parseRSS(x, 'prensa')],
    ['prensaAmbiente', 'https://news.google.com/rss/search?q=%22WWF+Colombia%22+OR+%22WWF%22+biodiversidad+Colombia+when:30d&hl=es-419&gl=CO&ceid=CO:es-419', 'prensa', x => parseRSS(x, 'prensa')]
  ];
  var galeria = []; var videosSueltos = [];
  for (const [nombre, url, tipo, parse] of FUENTES) {
    try { const items = parse(await traer(url)); estado[nombre] = items.length; nuevos[tipo].push(...items); console.log(`✓ ${nombre}: ${items.length}`); }
    catch (e) { estado[nombre] = 'error: ' + e.message; console.log(`✗ ${nombre}: ${e.message}`); }
  }

  // Unir con lo anterior
  const unir = (viejos, frescos, tope) => {
    const porId = new Map();
    for (const it of [...(viejos || []), ...frescos]) {
      const prev = porId.get(it.id);
      porId.set(it.id, prev
        ? { ...prev, ...Object.fromEntries(Object.entries(it).filter(([k, v]) => v && !(k === 'titulo' && prev.titulo && prev.titulo.length > v.length))), primeraVez: prev.primeraVez }
        : { ...it, primeraVez: it.primeraVez || AHORA.toISOString() });
    }
    const vistos = new Set(); const lista = [];
    for (const it of [...porId.values()].sort((a, b) => (b.fecha || b.primeraVez).localeCompare(a.fecha || a.primeraVez))) {
      const k = clave(it.titulo); if (vistos.has(k)) continue; vistos.add(k); lista.push(it);
    }
    return lista.slice(0, tope);
  };
  const wwf = unir(previo.wwf, nuevos.wwf, 80);
  const idsWWF = new Set(wwf.map(i => clave(i.titulo)));
  const prensa = unir(previo.prensa, nuevos.prensa, 80).filter(i => !idsWWF.has(clave(i.titulo)));
  // Las notas de Google Noticias no traen foto: se la presta la misma nota si llegó por Bing
  const conFoto = nuevos.prensa.filter(i => i.imagen);
  for (const it of prensa) if (!it.imagen) {
    const k = clave(it.titulo).slice(0, 40);
    const par = conFoto.find(b => clave(b.titulo).slice(0, 40) === k);
    if (par) { it.imagen = par.imagen; it.credito = par.credito; }
  }

  // Foto, crédito y video de cada nota de WWF (abre la nota)
  let abiertas = 0;
  for (const it of wwf) {
    if ((it.imagen && it.fotoRevisada) || abiertas >= 20 || !it.enlace.includes('wwf.org.co') || tiempo() > LIMITE * 0.45 || ruta['www.wwf.org.co'] === 'caido') continue;
    try {
      const h = await traer(it.enlace); abiertas++;
      const og = meta(h, 'og:image');
      const fotos = fotosDe(h);
      const deNota = fotos.find(f => f.img !== absoluto(fotoGenerica || ' '));
      if (og && absoluto(og) !== absoluto(fotoGenerica || ' ')) { it.imagen = absoluto(og); it.credito = (fotos.find(f => f.img === absoluto(og)) || deNota || {}).credito || it.credito || '© WWF'; }
      else if (deNota) { it.imagen = deNota.img; it.credito = deNota.credito; }
      const vids = videosDe(h); if (vids.length) it.video = vids[0];
      if (!it.resumen) it.resumen = meta(h, 'og:description').slice(0, 280);
      it.fotoRevisada = true;
      galeria.push(...fotos.slice(0, 4).map(f => ({ ...f, pagina: it.enlace })));
      await espera(300);
    } catch (e) { console.log('nota sin abrir', it.id, e.message); }
  }
  estado.notasAbiertas = abiertas;
  let deMedios = 0;
  for (const it of prensa) {
    if (it.imagen || it.fotoRevisada || deMedios >= 25 || tiempo() > LIMITE * 0.5 || /news\.google\.com/.test(it.enlace)) continue;
    try {
      const h = await directo(it.enlace, 10000); deMedios++;
      const og = meta(h, 'og:image') || meta(h, 'twitter:image');
      if (og && /^https?:|^\/\//.test(og)) { it.imagen = og.startsWith('//') ? 'https:' + og : og; it.credito = '© ' + it.fuente; }
    } catch {}
    it.fotoRevisada = true;
  }
  for (const it of prensa) if (!it.imagen) {
    const k = clave(it.titulo).slice(0, 40);
    const par = prensa.find(b => b.imagen && clave(b.titulo).slice(0, 40) === k);
    if (par) { it.imagen = par.imagen; it.credito = par.credito; }
  }
  estado.fotosPrensa = prensa.filter(i => i.imagen).length;

  // Fotos de regiones, frentes y especiales (se refrescan una vez al día)
  const media = previo.media || {};
  const viejo = !media.actualizado || (AHORA - new Date(media.actualizado)) > 20 * 3600 * 1000;
  if (viejo) {
    media.paginas = media.paginas || {};
    let ok = 0;
    for (const [k, camino] of Object.entries(PAGINAS)) {
      if (tiempo() > LIMITE * 0.7 || ruta['www.wwf.org.co'] === 'caido') break;
      try {
        const h = await traer(BASE + camino);
        const fotos = fotosDe(h);
        const og = meta(h, 'og:image');
        const principal = og && absoluto(og) !== absoluto(fotoGenerica || ' ') ? { img: absoluto(og), credito: (fotos.find(f => f.img === absoluto(og)) || fotos[0] || {}).credito || '© WWF' } : fotos[0];
        if (principal) { media.paginas[k] = { ...principal, fotos: fotos.slice(0, 8), pagina: BASE + camino }; ok++; }
        galeria.push(...fotos.slice(0, 6).map(f => ({ ...f, pagina: BASE + camino })));
        videosSueltos.push(...videosDe(h));
        await espera(300);
      } catch (e) { console.log(`✗ página ${k}: ${e.message}`); }
    }
    estado.paginasConFoto = ok;
    if (ok) media.actualizado = AHORA.toISOString();
  }
  // Galería sin repetidas
  const g = new Map();
  for (const f of [...galeria, ...(media.galeria || [])]) if (f && f.img && !g.has(f.img)) g.set(f.img, f);
  media.galeria = [...g.values()].slice(0, 80);
  estado.fotosGaleria = media.galeria.length;

  // Videos
  let videos = previo.videos || [];
  try {
    const canal = await videosCanal();
    const m = new Map(videos.map(v => [v.id, v]));
    for (const v of canal) m.set(v.id, { ...(m.get(v.id) || {}), ...v });
    videos = [...m.values()].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '')).slice(0, 30);
    estado.videosCanal = canal.length;
    console.log(`✓ videos del canal: ${canal.length}`);
  } catch (e) { estado.videosCanal = 'error: ' + e.message; console.log('✗ videos del canal:', e.message); }
  for (const id of new Set(videosSueltos)) if (!videos.some(v => v.id === id)) videos.push({ id, titulo: '', resumen: '', fecha: null, canal: 'WWF Colombia' });

  // Inglés
  const prevPorId = new Map([...(previo.wwf || []), ...(previo.prensa || []), ...(previo.videos || [])].map(i => [i.id, i]));
  for (const it of wwf) await traducir(it, ['titulo', 'resumen'], prevPorId.get(it.id));
  for (const it of prensa.slice(0, 40)) await traducir(it, ['titulo'], prevPorId.get(it.id));
  for (const v of videos) await traducir(v, ['titulo', 'resumen'], prevPorId.get(v.id));
  estado.traducciones = traducciones; if (errorTraduccion) estado.errorTraduccion = errorTraduccion;
  estado.rutas = via; estado.segundos = Math.round(tiempo());

  // ¿Cambió algo?
  const firma = o => JSON.stringify([o.wwf, o.prensa, o.videos, o.media && o.media.galeria && o.media.galeria.length, o.media && o.media.paginas && Object.keys(o.media.paginas).length].map(x => JSON.stringify(x)));
  const salida = {
    actualizado: AHORA.toISOString(),
    actualizadoBogota: AHORA.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'long', timeStyle: 'short' }),
    fuentes: estado, wwf, prensa, videos, media
  };
  if (firma(salida) === firma(previo)) { console.log('Sin novedades: no se toca el archivo.'); return; }
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(salida, null, 1) + '\n');
  console.log(`Guardado: ${wwf.length} WWF, ${prensa.length} prensa, ${videos.length} videos, ${media.galeria.length} fotos.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(0); });
