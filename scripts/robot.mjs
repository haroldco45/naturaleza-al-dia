// Robot de Naturaleza al Día — trae noticias reales de WWF Colombia y prensa
// Corre en GitHub Actions cada 30 minutos. Sin dependencias (Node 20+).
import fs from 'node:fs/promises';

const OUT = 'data/noticias.json';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; NaturalezaAlDiaBot/1.0; +https://github.com/haroldco45/naturaleza-al-dia)' };
const BASE = 'https://www.wwf.org.co';

const MESES = { ene:0, jan:0, feb:1, mar:2, abr:3, apr:3, may:4, jun:5, jul:6, ago:7, aug:7, sep:8, set:8, oct:9, nov:10, dic:11, dec:11 };
const ENT = { nbsp:' ', amp:'&', quot:'"', apos:"'", lt:'<', gt:'>', aacute:'á', eacute:'é', iacute:'í', oacute:'ó', uacute:'ú', ntilde:'ñ', Aacute:'Á', Eacute:'É', Iacute:'Í', Oacute:'Ó', Uacute:'Ú', Ntilde:'Ñ', uuml:'ü', iquest:'¿', iexcl:'¡', laquo:'«', raquo:'»', ldquo:'“', rdquo:'”', lsquo:'‘', rsquo:'’', ndash:'–', mdash:'—', hellip:'…', copy:'©' };

const deco = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n] ?? m);
const strip = s => deco(String(s || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// "19 oct 2026" → ISO (mediodía en Bogotá = 17:00 UTC)
function fechaES(t) {
  const m = String(t).match(/(\d{1,2})\s+([A-Za-zé]{3})[a-zé]*\.?\s+(?:de\s+)?(\d{4})/);
  if (!m) return null;
  const mm = MESES[m[2].toLowerCase().slice(0, 3)];
  if (mm == null) return null;
  return new Date(Date.UTC(+m[3], mm, +m[1], 17)).toISOString();
}

async function traer(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

const absoluto = href => {
  href = deco(href).trim();
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('http')) return href;
  if (href.startsWith('?')) return BASE + '/' + href;
  return BASE + (href.startsWith('/') ? '' : '/') + href;
};

// ---------- 1) Páginas de wwf.org.co ----------
export function parseWWF(html) {
  const items = new Map();
  const re = /<a\b[^>]*href="([^"]*\?(\d{5,7})(?:%2F|\/)([^"]*))"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const [, href, id, , inner] = m;
    let titulo = '', resumen = '', fecha = null, imagen = '';
    const fuerte = inner.match(/<(strong|b|h[1-6])[^>]*>([\s\S]*?)<\/\1>/i);
    const texto = strip(inner);
    fecha = fechaES(texto);
    const img = inner.match(/<img[^>]+(?:data-src|src)="([^"]+)"/i) || inner.match(/url\(['"]?([^'")]+)['"]?\)/i);
    if (img) imagen = absoluto(img[1]);
    if (fuerte) {
      titulo = strip(fuerte[2]);
      resumen = texto.split(titulo).slice(1).join(' ').trim();
    }
    // Bloques destacados ("Está pasando", "Te contamos"): el título va antes del enlace
    if (!titulo || titulo.length < 15) {
      const antes = html.slice(Math.max(0, m.index - 2500), m.index);
      const hs = [...antes.matchAll(/<(h[1-6]|strong)[^>]*>([\s\S]*?)<\/\1>/gi)];
      const h = hs.length ? hs[hs.length - 1] : null;
      if (h) {
        titulo = strip(h[2]);
        const despues = antes.slice(antes.lastIndexOf(h[0]) + h[0].length);
        const p = despues.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        resumen = p ? strip(p[1]) : strip(despues).slice(0, 300);
        const im = antes.match(/<img[^>]+(?:data-src|src)="([^"]+)"[^>]*>(?![\s\S]*<img)/i);
        if (im && !imagen) imagen = absoluto(im[1]);
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
      imagen: previo.imagen || imagen,
      enlace: absoluto(href),
      fuente: 'WWF Colombia',
      tipo: 'wwf',
      destacada: /Está pasando|Te contamos/i.test(texto) || previo.destacada || false
    });
  }
  return [...items.values()];
}

// ---------- 2) RSS (WWF y Google Noticias) ----------
export function parseRSS(xml, tipo) {
  const out = [];
  for (const it of xml.match(/<item\b[\s\S]*?<\/item>/gi) || []) {
    const tag = n => { const x = it.match(new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)<\\/${n}>`, 'i')); return x ? x[1] : ''; };
    let titulo = strip(tag('title'));
    const enlace = strip(tag('link')) || (it.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    const pub = strip(tag('pubDate'));
    let fuente = strip(tag('source')) || (tipo === 'wwf' ? 'WWF Colombia' : '');
    if (tipo === 'prensa' && fuente && titulo.endsWith(' - ' + fuente)) titulo = titulo.slice(0, -(fuente.length + 3));
    let resumen = strip(tag('description'));
    if (tipo === 'prensa') resumen = ''; // Google Noticias repite el título
    const fecha = pub && !isNaN(Date.parse(pub)) ? new Date(pub).toISOString() : null;
    const img = (it.match(/<(?:enclosure|media:content|media:thumbnail)[^>]+url="([^"]+)"/i) || [])[1] || '';
    if (!titulo || !enlace) continue;
    const idm = enlace.match(/\?(\d{5,7})(?:%2F|\/)/);
    out.push({
      id: idm ? 'wwf-' + idm[1] : tipo + '-' + hash(enlace),
      titulo, resumen: resumen.length > 280 ? resumen.slice(0, 277) + '…' : resumen,
      fecha, imagen: img, enlace, fuente: fuente || 'Prensa', tipo, destacada: false
    });
  }
  return out;
}

const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
const clave = t => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);

const FUENTES = {
  wwfInicio: { url: BASE + '/', tipo: 'wwf', parse: parseWWF },
  wwfNoticias: { url: BASE + '/de_interes/noticias/', tipo: 'wwf', parse: parseWWF },
  wwfRSS: { url: BASE + '/_template/_international/article/rss-feed.cfm?rss_xnav_id=203732&rss_obj_id=1632248&rss_lang_id=4&rss_xsite_id=1015&rss_language=es&rss_adminMode=false&rss_ArchiveMode=false', tipo: 'wwf', parse: x => parseRSS(x, 'wwf') },
  wwfRSSorigen: { url: 'https://originlaccms1.wwf-sites.org:8301/_template/_international/article/rss-feed.cfm?rss_xnav_id=203732&rss_obj_id=1632248&rss_lang_id=4&rss_xsite_id=1015&rss_language=es&rss_adminMode=false&rss_ArchiveMode=false', tipo: 'wwf', parse: x => parseRSS(x, 'wwf') },
  prensa: { url: 'https://news.google.com/rss/search?q=%22WWF%22+Colombia+when:30d&hl=es-419&gl=CO&ceid=CO:es-419', tipo: 'prensa', parse: x => parseRSS(x, 'prensa') },
  prensaAmbiente: { url: 'https://news.google.com/rss/search?q=%22WWF+Colombia%22+OR+%22WWF%22+biodiversidad+Colombia+when:30d&hl=es-419&gl=CO&ceid=CO:es-419', tipo: 'prensa', parse: x => parseRSS(x, 'prensa') }
};

async function main() {
  let previo = { wwf: [], prensa: [] };
  try { previo = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch {}

  const estado = {};
  const nuevos = { wwf: [], prensa: [] };
  for (const [nombre, f] of Object.entries(FUENTES)) {
    try {
      const txt = await traer(f.url);
      const items = f.parse(txt);
      estado[nombre] = items.length;
      nuevos[f.tipo].push(...items);
      console.log(`✓ ${nombre}: ${items.length}`);
    } catch (e) {
      estado[nombre] = 'error: ' + e.message;
      console.log(`✗ ${nombre}: ${e.message}`);
    }
  }

  const unir = (viejos, frescos, tope) => {
    const porId = new Map();
    for (const it of [...(viejos || []), ...frescos]) {
      const prev = porId.get(it.id);
      porId.set(it.id, prev ? {
        ...prev, ...Object.fromEntries(Object.entries(it).filter(([k, v]) => v && !(k === 'titulo' && prev.titulo && prev.titulo.length > v.length))),
        primeraVez: prev.primeraVez || it.primeraVez
      } : { ...it, primeraVez: it.primeraVez || new Date().toISOString() });
    }
    const vistos = new Set(); const lista = [];
    for (const it of [...porId.values()].sort((a, b) => (b.fecha || b.primeraVez).localeCompare(a.fecha || a.primeraVez))) {
      const k = clave(it.titulo);
      if (vistos.has(k)) continue;
      vistos.add(k); lista.push(it);
    }
    return lista.slice(0, tope);
  };

  const wwf = unir(previo.wwf, nuevos.wwf, 80);
  const idsWWF = new Set(wwf.map(i => clave(i.titulo)));
  const prensa = unir(previo.prensa, nuevos.prensa, 80).filter(i => !idsWWF.has(clave(i.titulo)));

  const firma = JSON.stringify([wwf.map(i => i.id + i.titulo), prensa.map(i => i.id)]);
  const firmaPrev = JSON.stringify([(previo.wwf || []).map(i => i.id + i.titulo), (previo.prensa || []).map(i => i.id)]);
  if (firma === firmaPrev) {
    console.log('Sin novedades: no se toca el archivo (así Netlify no redespliega en vano).');
    return;
  }

  const ahora = new Date();
  const salida = {
    actualizado: ahora.toISOString(),
    actualizadoBogota: ahora.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'long', timeStyle: 'short' }),
    fuentes: estado,
    wwf, prensa
  };
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(salida, null, 1) + '\n');
  console.log(`Guardado: ${wwf.length} de WWF, ${prensa.length} de prensa.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(0); });
