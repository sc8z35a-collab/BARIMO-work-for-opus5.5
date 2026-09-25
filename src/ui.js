// Rating visualizations: radar chart, rings, bars; climate chart. Palette: calm greens → warm ambers → terracotta.
export const RATING_DEFS = [
  { k: 'scenery', label: '景観美', en: 'Scenery', good: 'high' },
  { k: 'remoteness', label: '秘境度', en: 'Remoteness', good: 'high' },
  { k: 'crime', label: '犯罪リスク', en: 'Crime', good: 'low' },
  { k: 'danger', label: '自然の危険', en: 'Hazards', good: 'low' },
  { k: 'access', label: 'アクセス難度', en: 'Access', good: 'low' },
  { k: 'physical', label: '体力難度', en: 'Physical', good: 'low' },
  { k: 'infra', label: '設備の充実', en: 'Facilities', good: 'high' },
  { k: 'cost', label: '費用感', en: 'Cost', good: 'low' },
];
const LEVEL = {
  low: ['とても低い', '低い', 'ふつう', '高い', 'とても高い'],
  high: ['控えめ', 'ややあり', 'ふつう', '高い', '最高'],
};
// color by "how favorable" (0 = bad, 1 = great) — muted natural tones only
function favColor(f) { return f > 0.7 ? '#5aa47c' : f > 0.45 ? '#9bb34d' : f > 0.25 ? '#d8a44a' : '#d0775a'; }

function ring(value, color, label) {
  const r = 20, c = 2 * Math.PI * r, off = c * (1 - value / 100);
  return `<svg class="ring" viewBox="0 0 50 50"><circle cx="25" cy="25" r="${r}" fill="none" stroke="rgba(38,52,60,.08)" stroke-width="5"/>
    <circle cx="25" cy="25" r="${r}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 25 25)"/>
    <text x="25" y="29" text-anchor="middle" font-size="13" font-weight="700" fill="#26343c" font-family="Cormorant Garamond, serif">${value}</text></svg><div><b>${label}</b>`;
}

function radar(R, accent) {
  const n = RATING_DEFS.length, cx = 150, cy = 130, rad = 92;
  const pt = (i, v) => { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; return [cx + Math.cos(a) * rad * v, cy + Math.sin(a) * rad * v]; };
  const grid = [0.2, 0.4, 0.6, 0.8, 1].map((s) => `<polygon points="${RATING_DEFS.map((_, i) => pt(i, s).join(',')).join(' ')}" fill="${s === 1 ? 'rgba(255,255,255,.5)' : 'none'}" stroke="rgba(38,52,60,.1)"/>`).join('');
  const axes = RATING_DEFS.map((_, i) => `<line x1="${cx}" y1="${cy}" x2="${pt(i, 1)[0]}" y2="${pt(i, 1)[1]}" stroke="rgba(38,52,60,.08)"/>`).join('');
  // plot "favorability" so bigger shape = better trip
  const fav = RATING_DEFS.map((d) => (d.good === 'high' ? R[d.k] : 6 - R[d.k]) / 5);
  const poly = fav.map((v, i) => pt(i, v).join(',')).join(' ');
  const dots = fav.map((v, i) => `<circle cx="${pt(i, v)[0]}" cy="${pt(i, v)[1]}" r="3.5" fill="#fff" stroke="${accent}" stroke-width="2"/>`).join('');
  const lbl = RATING_DEFS.map((d, i) => { const [x, y] = pt(i, 1.22); return `<text x="${x}" y="${y + 4}" text-anchor="middle" font-size="11" fill="#4c5d66" font-weight="700">${d.label}</text>`; }).join('');
  return `<svg class="radar" viewBox="0 0 300 260">${grid}${axes}<polygon points="${poly}" fill="${accent}" fill-opacity=".28" stroke="${accent}" stroke-width="2.2" stroke-linejoin="round"/>${dots}${lbl}</svg>`;
}

export function ratingsHTML(r) {
  const R = r.ratings, N = r.ratingNotes || {};
  const safety = Math.round(((6 - R.crime) + (6 - R.danger)) / 10 * 100);
  const rows = RATING_DEFS.map((d) => {
    const v = R[d.k], fav = d.good === 'high' ? v / 5 : (6 - v) / 5, col = favColor(fav);
    return `<div class="rrow"><div class="top">${d.label} <em>${d.en}</em><span class="lvl" style="background:${col}">${LEVEL[d.good][v - 1]}</span></div>
      <div class="pips">${[1, 2, 3, 4, 5].map((i) => `<i style="${i <= v ? `background:${col}` : ''}"></i>`).join('')}</div>
      ${N[d.k] ? `<p>${N[d.k]}</p>` : ''}</div>`;
  }).join('');
  return `<h3>総合評価</h3>
    <div class="score-hero">
      <div>${ring(r.gem, r.accent, '秘境度')}<small>景観の美しさ × 人の少なさ</small></div></div>
      <div>${ring(safety, favColor(safety / 100), '安全度')}<small>犯罪リスクと自然の危険から算出</small></div></div>
    </div>
    <div class="score-hero" style="margin-top:8px">
      <div>${ring(r.ease, favColor(r.ease / 100), '行きやすさ')}<small>治安・危険・アクセス・体力の総合</small></div></div>
    </div>
    <h3>多角評価レーダー</h3>
    <div class="radar-wrap">${radar(R, r.accent)}</div>
    <p class="credit-note" style="text-align:center;margin-top:0">外側に広いほど「旅として快適・魅力的」</p>
    <h3>項目別の詳細</h3><div class="rt">${rows}</div>
    <p class="credit-note">評価は各国政府の渡航情報・現地ガイド・旅行記など複数ソースを基にBARIMOが独自に算出（2026年9月時点）。渡航前には必ず最新の公式情報を確認してください。</p>`;
}

export function climateSVG(months, accent, best) {
  const W = 320, H = 150, pl = 26, pr = 26, pt = 14, pb = 22;
  const iw = W - pl - pr, ih = H - pt - pb, bw = iw / 12;
  const tmax = Math.max(...months.map((m) => m.tmax)), tmin = Math.min(...months.map((m) => m.tmin));
  const lo = Math.floor(Math.min(tmin, 0) / 5) * 5, hi = Math.ceil(Math.max(tmax, 10) / 5) * 5;
  const ty = (t) => pt + ih * (1 - (t - lo) / (hi - lo));
  const rmax = Math.max(60, ...months.map((m) => m.rain));
  const bars = months.map((m, i) => { const bh = (m.rain / rmax) * ih * 0.8; return `<rect x="${pl + i * bw + bw * 0.2}" y="${pt + ih - bh}" width="${bw * 0.6}" height="${bh}" rx="2" fill="${best.has(i + 1) ? accent : '#a9c8d8'}" opacity="${best.has(i + 1) ? 0.55 : 0.4}"/>`; }).join('');
  const line = (k) => months.map((m, i) => `${pl + i * bw + bw / 2},${ty(m[k])}`).join(' ');
  const zero = lo < 0 ? `<line x1="${pl}" x2="${W - pr}" y1="${ty(0)}" y2="${ty(0)}" stroke="rgba(38,52,60,.15)" stroke-dasharray="3 3"/>` : '';
  const xl = months.map((_, i) => `<text x="${pl + i * bw + bw / 2}" y="${H - 6}" font-size="9" text-anchor="middle" fill="#7b8b93">${i + 1}</text>`).join('');
  const yl = [lo, (lo + hi) / 2, hi].map((t) => `<text x="${pl - 5}" y="${ty(t) + 3}" font-size="9" text-anchor="end" fill="#7b8b93">${t}°</text>`).join('');
  const rl = `<text x="${W - pr + 4}" y="${pt + ih * 0.2 + 3}" font-size="9" fill="#7b8b93">${Math.round(rmax)}mm</text>`;
  return `<svg viewBox="0 0 ${W} ${H}">${bars}${zero}
    <polyline points="${line('tmax')}" fill="none" stroke="#e0a458" stroke-width="2.2" stroke-linejoin="round"/>
    <polyline points="${line('tmin')}" fill="none" stroke="#6aa0c8" stroke-width="2.2" stroke-linejoin="round"/>
    ${xl}${yl}${rl}</svg>
    <p class="credit-note" style="margin-top:4px"><span style="color:#e0a458">━</span> 最高気温　<span style="color:#6aa0c8">━</span> 最低気温　<span style="color:${accent}">■</span> 降水量（ベストシーズン）</p>`;
}
