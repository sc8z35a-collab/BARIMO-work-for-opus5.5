// AGENT 4 — PHOTOS: harvests CC/PD photographs from Wikimedia Commons (text + geo search),
sharp.cache(false); sharp.concurrency(1);
// filters out maps/diagrams/dark images, scores by brightness/colorfulness, stores webp + credits.
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs';
import { regions, fetchJSON, fetchBuf, pool, log, regionDir, writeJSON, ensure, sleep } from '../lib/common.mjs';
const A = 'photos';
const API = 'https://commons.wikimedia.org/w/api.php?';
const MAX = +process.env.PHOTOS_MAX || 12;
const BAD = /(map|karte|carte|mapa|flag|coat of arms|logo|diagram|chart|plan|svg|stamp|banknote|coin|poster|document|sign\b|signboard|panel|scheme|locator|relief|topograph|blank|portrait of|selfie)/i;
const OK_LIC = /(cc|public domain|pd|attribution|share ?alike|cc0)/i;

const q = (params) => API + new URLSearchParams({ format: 'json', origin: '*', ...params });
const iiprops = { prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1920' };

async function candidates(r) {
  const out = new Map();
  const add = (pages, src) => Object.values(pages || {}).forEach((p) => { if (!out.has(p.title)) out.set(p.title, { ...p, src }); });
  for (const term of r.photoQueries) {
    const d = await fetchJSON(q({ action: 'query', generator: 'search', gsrsearch: `${term} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '40', ...iiprops }));
    add(d?.query?.pages, 'search:' + term); await sleep(300);
  }
  const pts = [r.center, ...(r.pois || []).map((p) => p.ll)];
  for (const [lat, lon] of pts) {
    const d = await fetchJSON(q({ action: 'query', generator: 'geosearch', ggscoord: `${lat}|${lon}`, ggsradius: '10000', ggsnamespace: '6', ggslimit: '40', ...iiprops }));
    add(d?.query?.pages, 'geo'); await sleep(300);
  }
  return [...out.values()];
}

const strip = (s = '') => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function build(r) {
  if (fs.existsSync(path.join(regionDir(r.id), 'photos.json')) && !process.env.FORCE) return log(A, `${r.id}: cached`);
  const dir = ensure(path.join(regionDir(r.id), 'photos'));
  const cands = (await candidates(r)).filter((p) => {
    const ii = p.imageinfo?.[0]; if (!ii) return false;
    const m = ii.extmetadata || {};
    const lic = strip(m.LicenseShortName?.value || '');
    return /jpeg|png/.test(ii.mime) && ii.width >= 1400 && ii.width >= ii.height * 1.15 // landscape only (phone is landscape)
      && !BAD.test(p.title) && !BAD.test(strip(m.ImageDescription?.value || '').slice(0, 200)) && OK_LIC.test(lic);
  });
  log(A, `${r.id}: ${cands.length} candidates`);
  const scored = (await pool(cands.slice(0, 50), 4, async (p) => {
    const ii = p.imageinfo[0];
    try {
      const buf = await fetchBuf(ii.thumburl || ii.url);
      const img = sharp(buf).rotate();
      const st = await img.clone().resize(96, 64, { fit: 'cover' }).stats();
      const [R, G, B] = st.channels.map((c) => c.mean);
      const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      const sat = mx ? (mx - mn) / mx : 0;
      const contrast = st.channels.reduce((a, c) => a + c.stdev, 0) / 3;
      const blueSky = B > R ? 6 : 0;
      // bright, colorful, contrasty images win; murky/dark ones are penalized hard
      const score = (lum < 85 ? -80 : 0) + (lum > 200 && contrast < 45 ? -40 : 0) + lum * 0.35 + sat * 90 + contrast * 0.4 + blueSky + (p.src === 'geo' ? 0 : 8);
      return { p, buf, score, lum, sat };
    } catch { return null; }
  })).filter(Boolean).filter((s) => s.lum >= 80).sort((a, b) => b.score - a.score);

  const picked = scored.slice(0, MAX);
  const credits = [];
  let n = 0;
  for (const s of picked) {
    const m = s.p.imageinfo[0].extmetadata || {};
    const file = `p${String(++n).padStart(2, '0')}`;
    const base = sharp(s.buf).rotate().modulate({ saturation: 1.06 });
    await base.clone().resize(1920, 1080, { fit: 'cover', position: 'attention' }).webp({ quality: 84 }).toFile(path.join(dir, file + '.webp'));
    await base.clone().resize(640, 360, { fit: 'cover', position: 'attention' }).webp({ quality: 76 }).toFile(path.join(dir, file + '_s.webp'));
    credits.push({
      file: `photos/${file}.webp`, thumb: `photos/${file}_s.webp`,
      title: strip(s.p.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '')),
      author: strip(m.Artist?.value || 'Unknown').slice(0, 80),
      license: strip(m.LicenseShortName?.value || ''),
      source: s.p.imageinfo[0].descriptionurl, score: Math.round(s.score),
    });
  }
  writeJSON(path.join(regionDir(r.id), 'photos.json'), credits);
  log(A, `${r.id}: kept ${credits.length} photos`);
}

const list = regions().filter((r) => !process.argv[2] || r.id === process.argv[2]);
await pool(list, 1, (r) => build(r).catch((e) => log(A, `${r.id} FAILED ${e.message}`)));
log(A, 'done');
