/* 诊断 batch composition 的推导准确度：
   逐步比对「推导出的训练样本合计」与官方 batch size，
   确认只在重启步才需要近似。 */
const BASE = 'http://127.0.0.1:8787/';
async function g(u) { const r = await fetch(BASE + u); return r.json(); }

(async function () {
  const m = await g('api/runs');
  const cats = m.categories;
  const tagsJson = await g('api/tags?run=pro');
  const re = /^dynsam\/([^/]+)\/([^/]+)\/num_accepted\/step$/;
  const items = tagsJson.tags.map(function (t) { return re.exec(t); })
    .filter(function (x) { return x && cats.indexOf(x[1]) >= 0; })
    .map(function (x) { return { cat: x[1], ds: x[2], key: x[1] + '/' + x[2] }; });
  console.log('数据源数:', items.length, '| 类别:', cats.join(','));

  const need = [];
  items.forEach(function (it) {
    ['step', 'held', 'carryover'].forEach(function (k) { need.push('dynsam/' + it.key + '/num_accepted/' + k); });
  });
  need.push('dynsam/num_target');
  const s = await g('api/series?run=pro&tags=' + encodeURIComponent(need.join(',')));
  const steps = s.steps, n = steps.length;
  const get = function (it, k) { return s.series['dynsam/' + it.key + '/num_accepted/' + k] || []; };
  const bszS = s.series['dynsam/num_target'] || [];

  let approxCount = 0; const approxSteps = [];
  for (let i = 0; i < n; i++) {
    const bsz = bszS[i] || 0;
    let sum = 0;
    items.forEach(function (it) {
      const a = get(it, 'step')[i] || 0, h = get(it, 'held')[i] || 0;
      const hp = i ? (get(it, 'held')[i - 1] || 0) : null;
      const v = hp == null ? null : Math.max(0, hp + a - h);
      if (v != null) sum += v;
    });
    const sane = i > 0 && bsz && Math.abs(sum - bsz) <= 0.05 * bsz;
    if (!sane) { approxCount++; approxSteps.push(steps[i]); }
    else if (i < 5 || i >= n - 3) {
      console.log('  step ' + steps[i] + ': 推导=' + Math.round(sum) +
                  ' 官方bsz=' + bsz + ' 偏差=' + ((sum - bsz) / bsz * 100).toFixed(1) + '%');
    }
  }
  console.log('\n总步数 ' + n + '，近似步 ' + approxCount + '：' + approxSteps.join(','));
})().catch(function (e) { console.log('ERR', e.message); });
