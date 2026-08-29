/* TeslaMate 遥测面板前端逻辑 */
(function () {
  'use strict';

  const S = {
    carId: null,
    days: 7,
    theme: localStorage.getItem('ttv-theme') || 'dark',
    battMode: localStorage.getItem('ttv-batt-mode') || 'pct',
    carMode: localStorage.getItem('ttv-car-mode') || 'pct',
    overview: null,
    health: null,
    cycles: null,
    cycleIdx: 0,
    sessions: null,
    timer: null,
  };

  const charts = {};
  let map = null;
  let mapTiles = {};
  let mapFit = false;

  /* ---------- 工具 ---------- */

  const $ = (sel) => document.querySelector(sel);
  const cssVar = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // 窄屏(与 style.css 的 900px 断点一致):图表边距与触摸控件随之收紧/放大
  const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;
  // 趋势图网格:桌面为末端数值标签多留右侧空间,窄屏收紧
  const trendGrid = (top) => ({
    left: 8, right: isNarrow() ? 24 : 40, top, bottom: 4, containLabel: true,
  });

  // 电量 ⇄ 里程换算:以最近一次上报的「额定续航 / 可用电量」推定满电续航,线性折算
  const kmFull = () => {
    const lat = S.overview && S.overview.latest;
    if (!lat) return null;
    const pct = Number(lat.usable_battery_level);
    const km = Number(lat.rated_battery_range_km);
    if (!(pct > 0) || !(km > 0)) return null;
    return km / pct * 100;
  };
  const kmAtPct = (pct) => {
    const f = kmFull();
    const p = Number(pct);
    if (f === null || p === null || isNaN(p)) return null;
    return f * p / 100;
  };
  // 电量百分比对应的里程提示,如「≈ 353 km」;无法折算时返回空串
  const kmSuffix = (pct) => {
    const km = kmAtPct(pct);
    return km === null ? '' : `≈ ${fmtNum(km, 0)} km`;
  };
  // 电量曲线 tooltip 的双单位补充:主单位之外的「≈ 里程 / ≈ 电量」
  const dualBatt = {
    '仪表电量': (v) => kmSuffix(v),
    '电量': (v) => kmSuffix(v),
    '剩余里程(折算)': (v) => {
      const f = kmFull();
      return !f ? '' : `≈ ${fmtNum(v / f * 100, 0)}%`;
    },
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  const fmtNum = (n, d = 0) =>
    (n === null || n === undefined || isNaN(n)) ? '—'
      : Number(n).toLocaleString('zh-CN', {
          maximumFractionDigits: d, minimumFractionDigits: d });

  const fmtTime = (ms, withSec = false) => {
    if (ms === null || ms === undefined) return '—';
    const t = new Date(Number(ms));
    return t.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      second: withSec ? '2-digit' : undefined,
      hour12: false,
    }).replace(/\//g, '-');
  };

  const fmtClock = (ms) => {
    const t = new Date(Number(ms));
    return t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  const localMidnight = (ms) => {
    const d = new Date(Number(ms));
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };

  const dayKey = (ms) => {
    const d = new Date(Number(ms));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const dayLabel = (ms) => {
    const d = new Date(Number(ms));
    const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return `${d.getMonth() + 1}月${d.getDate()}日 · 周${wd}`;
  };

  // 活动分类:行驶 / 充电 / 哨兵 / 驻车耗电
  const CAT = {
    drive: { label: '行驶', cls: 'cat-drive', colorVar: '--cat-drive' },
    charge: { label: '充电', cls: 'cat-charge', colorVar: '--cat-charge' },
    sentry: { label: '哨兵', cls: 'cat-sentry', colorVar: '--cat-sentry' },
    idle: { label: '驻车耗电', cls: 'cat-idle', colorVar: '--cat-idle' },
  };

  const STATE_LABEL = {
    driving: '行驶中', charging: '充电中', online: '在线',
    offline: '驻车 / 离线', asleep: '休眠', unknown: '未知',
  };

  /* ---------- 主题 ---------- */

  function applyTheme() {
    document.documentElement.dataset.theme = S.theme;
    localStorage.setItem('ttv-theme', S.theme);
    const btn = $('#theme-btn');
    btn.textContent = S.theme === 'dark' ? '☀ 浅色' : '🌙 深色';
    const mc = document.querySelector('meta[name="theme-color"]');
    if (mc) mc.content = S.theme === 'dark' ? '#0d0d0d' : '#f9f9f7';
    switchMapTheme();
    Object.values(charts).forEach((c) => c && c.setOption(chartTheme(), { notMerge: true }));
    renderAll();
  }

  /* ---------- 电量 / 里程 切换 ---------- */

  function battToggleEl() {
    const seg = el('div', 'seg mini batt-toggle');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', '电量/里程切换');
    ['pct', 'km'].forEach((m) => {
      const b = el('button', m === S.battMode ? 'on' : '');
      b.type = 'button';
      b.dataset.mode = m;
      b.textContent = m === 'pct' ? '电量 %' : '里程 km';
      seg.appendChild(b);
    });
    return seg;
  }

  function setBattMode(mode) {
    if (mode !== 'pct' && mode !== 'km') return;
    S.battMode = mode;
    localStorage.setItem('ttv-batt-mode', mode);
    document.querySelectorAll('.batt-toggle button').forEach((b) =>
      b.classList.toggle('on', b.dataset.mode === mode));
    // 仅重绘电量相关视图(避免地图 fitBounds 被重置)
    renderHeader(); renderKpis(); renderTrends(); renderActivity(); renderSentry();
  }

  function chartTheme() {
    return {
      backgroundColor: 'transparent',
      textStyle: {
        color: cssVar('--text-secondary'),
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      },
    };
  }

  /* ---------- 图表公共配置 ---------- */

  function axisCommon() {
    return {
      axisLine: { lineStyle: { color: cssVar('--baseline'), width: 1 } },
      axisTick: { show: false },
      axisLabel: { color: cssVar('--text-muted'), fontSize: 11 },
      splitLine: { lineStyle: { color: cssVar('--gridline'), width: 1 } },
    };
  }

  function tooltipAxis(unitMap, headerFmt, dual) {
    return {
      trigger: 'axis',
      backgroundColor: cssVar('--surface-1'),
      borderColor: cssVar('--border'),
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: cssVar('--text-primary'), fontSize: 12 },
      extraCssText: 'box-shadow: 0 4px 16px rgba(0,0,0,.18);border-radius:8px;',
      axisPointer: {
        type: 'line',
        lineStyle: { color: cssVar('--baseline'), width: 1 },
      },
      formatter(params) {
        const p0 = params[0];
        let s = `<div style="color:${cssVar('--text-muted')};font-size:11px;margin-bottom:4px">` +
                (headerFmt ? headerFmt(p0.axisValue) : p0.axisValue) + '</div>';
        params.forEach((p) => {
          const v = p.value != null && p.value[1] != null ? fmtNum(p.value[1], 1) : '—';
          const unit = (unitMap && unitMap[p.seriesName]) || '';
          const alt = (dual && dual[p.seriesName]) ? dual[p.seriesName](Number(p.value[1])) : '';
          s += `<div style="line-height:1.7"><span style="display:inline-block;width:14px;height:2px;` +
               `background:${p.color};vertical-align:middle;margin-right:6px"></span>` +
               `<b>${v} ${unit}</b>` +
               (alt ? ` <span style="color:${cssVar('--text-muted')}">${alt}</span>` : '') +
               ` <span style="color:${cssVar('--text-muted')}">${p.seriesName}</span></div>`;
        });
        return s;
      },
    };
  }

  function timeAxis(days) {
    return Object.assign(axisCommon(), {
      type: 'time',
      axisLabel: {
        color: cssVar('--text-muted'), fontSize: 11,
        formatter: (v) => (days <= 1 ? fmtClock(v) : `${fmtTime(v).slice(0, 5)}`),
      },
    });
  }

  /* ---------- 渲染:KPI ---------- */

  function renderKpis() {
    const o = S.overview;
    const box = $('#kpis');
    box.textContent = '';
    const lat = o && o.latest;
    const t = o && o.totals;

    function tile(label, value, unit, sub, meterPct, headRight) {
      const d = el('div', 'tile');
      const labRow = el('div', 'tile-head');
      labRow.appendChild(el('div', 'label', label));
      if (headRight) labRow.appendChild(headRight);
      d.appendChild(labRow);
      const vrow = el('div', 'value');
      vrow.textContent = value === null || value === undefined || value === '—' ? '—' : value;
      if (unit) vrow.appendChild(el('span', 'unit', unit));
      d.appendChild(vrow);
      if (sub) d.appendChild(el('div', 'sub', sub));
      if (meterPct !== null && meterPct !== undefined) {
        const m = el('div', 'meter' + (meterPct < 20 ? ' low' : '') + (meterPct < 10 ? ' critical' : ''));
        const fill = el('i');
        fill.style.width = Math.min(100, Math.max(0, meterPct)) + '%';
        m.appendChild(fill);
        d.appendChild(m);
      }
      return d;
    }

    const usable = lat ? Number(lat.usable_battery_level) : null;
    const batt = lat ? Number(lat.battery_level) : null;
    const rated = lat ? Number(lat.rated_battery_range_km) : null;
    const odo = lat ? Number(lat.odometer) : null;
    const outT = lat ? Number(lat.outside_temp) : null;
    const inT = lat ? Number(lat.inside_temp) : null;

    // 电量卡:主值可按电量 / 里程切换,副信息固定同时展示两者
    const kmMode = S.battMode === 'km' && kmFull() !== null;
    const battTileSub = (batt === null ? '—' : `仪表电量 ${fmtNum(batt, 0)}%`) +
      (rated !== null ? ` · 额定续航 ${fmtNum(rated, 0)} km` : '');
    box.appendChild(tile(kmMode ? '剩余里程' : '电量',
      kmMode
        ? (rated === null ? '—' : fmtNum(rated, 0))
        : (usable === null ? '—' : fmtNum(usable, 0)),
      kmMode ? (rated === null ? '' : 'km') : (usable === null ? '' : '%'),
      battTileSub, usable, battToggleEl()));
    box.appendChild(tile('额定续航', fmtNum(rated, 0), 'km',
      '由车辆 API 上报', null));
    box.appendChild(tile('总里程', fmtNum(odo, 0), 'km',
      lat ? `最近数据 ${fmtTime(Number(lat.date_ts))}` : '暂无位置数据', null));
    box.appendChild(tile('车外温度', fmtNum(outT, 1), '°C',
      inT === null ? '' : `车内 ${fmtNum(inT, 1)} °C`, null));
    box.appendChild(tile('本月里程', fmtNum(t ? t.month_km : 0, 1), 'km',
      t ? `本月能耗约 ${fmtNum(t.month_energy_kwh, 0)} kWh · 累计 ${fmtNum(t.year_km, 0)} km` : '', null));
  }

  /* ---------- 渲染:顶栏状态 ---------- */

  // 服务器硬盘 / 内存占用(顶栏第二行)
  function renderSys(sys) {
    if (!sys) return;
    // 可视化仪表条:填充宽度 = 使用率,数值文字 + 悬停显示用量详情;
    // ≥75% 转黄,≥90% 转红(与电量胶囊的警示色一致)
    const setMeter = (id, pct, detail) => {
      const m = $(id);
      if (!m) return;
      if (pct === null || pct === undefined || Number.isNaN(Number(pct))) {
        m.hidden = true;
        return;
      }
      const v = Number(pct);
      m.hidden = false;
      m.title = detail;
      m.dataset.level = v >= 90 ? 'critical' : (v >= 75 ? 'warn' : 'ok');
      $(id + '-fill').style.width = `${Math.min(100, Math.max(0, v))}%`;
      $(id + '-val').textContent = `${fmtNum(v, 0)}%`;
    };
    setMeter('#meter-disk', sys.disk_pct,
      `硬盘 ${fmtNum(sys.disk_used_gb, 0)}/${fmtNum(sys.disk_total_gb, 0)} GB`);
    setMeter('#meter-mem', sys.mem_pct,
      `内存 ${fmtNum(sys.mem_used_mb / 1024, 1)}/${fmtNum(sys.mem_total_mb / 1024, 1)} GB`);
  }

  // 车型显示名:库中 model 为单字母;车主确认本车(Y / 74D 双电机)为 Model Y L
  const MODEL_LABEL = { S: 'Model S', '3': 'Model 3', X: 'Model X', Y: 'Model Y' };
  const TRIM_LABEL = { 'Y|74D': 'Model Y L' };

  function renderHeader() {
    const o = S.overview;
    if (!o) return;
    const car = o.cars.find((c) => c.id === S.carId) || o.cars[0];
    $('#car-name').textContent = car ? car.name : '—';
    const trimKey = car ? `${car.model}|${car.trim_badging || ''}` : '';
    const modelLabel = TRIM_LABEL[trimKey] ||
      (car ? (MODEL_LABEL[car.model] || car.model || '') : '');
    // Model Y L 展示官方尾标徽章(PNG 蒙版 + currentColor 随主题变色);其他车型回退为文字
    const isYL = modelLabel === 'Model Y L';
    $('#car-model-badge').hidden = !isYL;
    const modelText = $('#car-model-text');
    modelText.hidden = isYL;
    if (!isYL) modelText.textContent = modelLabel;
    const badge = $('#state-badge');
    badge.dataset.state = o.state;
    $('#state-text').textContent = STATE_LABEL[o.state] || o.state;
    $('#sw-version').textContent = o.software_version ? `v${o.software_version}` : '';
    $('#updated-at').textContent = o.latest ? `数据更新 ${fmtTime(Number(o.latest.date_ts))}` : '暂无数据';

    // 电量胶囊:跟随全局 电量%⇄里程km 模式;里程直接用最新额定续航
    const lat = o.latest;
    const usable = lat && lat.usable_battery_level != null ? Number(lat.usable_battery_level)
      : (lat && lat.battery_level != null ? Number(lat.battery_level) : null);
    const rated = lat && lat.rated_battery_range_km != null ? Number(lat.rated_battery_range_km) : null;
    const kmMode = S.battMode === 'km' && kmFull() !== null;
    $('#batt-text').textContent = kmMode && rated !== null
      ? `${fmtNum(rated, 0)} km`
      : (usable === null ? '—' : `${fmtNum(usable, 0)}%`);
    const pct = usable === null ? 0 : Math.min(100, Math.max(0, usable));
    $('#batt-fill').setAttribute('width', (19 * pct / 100).toFixed(1));
    $('#batt-pill').dataset.level =
      usable === null ? 'unknown' : pct < 10 ? 'critical' : pct < 20 ? 'low' : 'ok';
  }

  /* ---------- 渲染:趋势图 ---------- */

  function lineSeries(name, data, color) {
    return {
      name, type: 'line', data,
      showSymbol: false,
      connectNulls: true,
      lineStyle: { width: 2, color, cap: 'round', join: 'round' },
      itemStyle: { color },
      emphasis: { lineStyle: { width: 2.5 } },
      endLabel: {
        show: true, formatter: (p) => fmtNum(p.value[1], 0),
        color: cssVar('--text-secondary'), fontSize: 11,
        backgroundColor: cssVar('--surface-1'), padding: [2, 5], borderRadius: 4,
      },
    };
  }

  function renderTrends() {
    const o = S.overview;
    if (!o || !charts.battery || !charts.range) return;
    const battData = (o.trendBattery || [])
      .filter((p) => p.battery_level !== null && p.battery_level !== undefined)
      .map((p) => [Number(p.date_ts), p.battery_level]);
    const ratedData = (o.trendRange || [])
      .filter((p) => p.rated_battery_range_km !== null && p.rated_battery_range_km !== undefined)
      .map((p) => [Number(p.date_ts), p.rated_battery_range_km]);

    // 电量曲线:可按电量 / 里程维度查看(里程按满电额定续航折算)
    const fullKm = kmFull();
    const kmMode = S.battMode === 'km' && fullKm !== null;
    const battSeries = kmMode
      ? battData.map(([t, p]) => [t, kmAtPct(p)]).filter((p) => p[1] !== null)
      : battData;
    // 单序列图表:标题即命名,无需图例
    const base = {
      tooltip: tooltipAxis({ '仪表电量': '%', '剩余里程(折算)': 'km', '额定续航': 'km' },
        (v) => fmtTime(v, true), dualBatt),
      grid: trendGrid(24),
    };

    charts.battery.setOption(Object.assign({}, chartTheme(), base, {
      xAxis: timeAxis(S.days),
      yAxis: Object.assign(axisCommon(), {
        type: 'value', min: 0,
        max: kmMode ? Math.ceil(fullKm / 100) * 100 : 100,
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11,
          formatter: kmMode ? '{value}' : '{value}%' },
      }),
      series: [lineSeries(kmMode ? '剩余里程(折算)' : '仪表电量', battSeries,
        cssVar('--series-1'))],
    }), { notMerge: true });

    charts.range.setOption(Object.assign({}, chartTheme(), base, {
      xAxis: timeAxis(S.days),
      yAxis: Object.assign(axisCommon(), { type: 'value', min: 0,
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11, formatter: '{value}' } }),
      series: [lineSeries('额定续航', ratedData, cssVar('--series-3'))],
    }), { notMerge: true });
  }

  /* ---------- 渲染:每日里程 / 充电 ---------- */

  function renderDaily() {
    const o = S.overview;
    if (!o || !charts.daily || !o.dailyRows) return;
    const map = {};
    o.dailyRows.forEach((r) => { map[r.day] = r; });
    const days = [], vals = [], now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (S.days - 1));
    for (let i = 0; i < S.days; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days.push(key);
      vals.push(map[key] ? Number(map[key].distance_km) : 0);
    }
    charts.daily.setOption(Object.assign({}, chartTheme(), {
      tooltip: {
        trigger: 'axis',
        backgroundColor: cssVar('--surface-1'),
        borderColor: cssVar('--border'), borderWidth: 1, padding: [8, 12],
        textStyle: { color: cssVar('--text-primary'), fontSize: 12 },
        axisPointer: { type: 'shadow', shadowStyle: { color: cssVar('--tile-track') } },
        formatter(params) {
          const p = params[0];
          const r = map[p.name];
          const drives = r ? r.drives : 0;
          const energy = r && o.kwhPerIdealKm ? Number(r.ideal_delta_km) * o.kwhPerIdealKm : 0;
          return `<div style="color:${cssVar('--text-muted')};font-size:11px;margin-bottom:4px">${p.name}</div>` +
                 `<div><span style="display:inline-block;width:14px;height:8px;border-radius:2px;` +
                 `background:${p.color};vertical-align:middle;margin-right:6px"></span>` +
                 `<b>${fmtNum(p.value, 1)} km</b> <span style="color:${cssVar('--text-muted')}">行驶里程</span></div>` +
                 `<div style="color:${cssVar('--text-muted')};margin-top:2px">${drives} 次行程 · 能耗约 ${fmtNum(energy, 1)} kWh</div>`;
        },
      },
      grid: { left: 8, right: 12, top: 24, bottom: 4, containLabel: true },
      xAxis: Object.assign(axisCommon(), { type: 'category', data: days,
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11, formatter: (v) => v.slice(5) } }),
      yAxis: Object.assign(axisCommon(), { type: 'value',
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11, formatter: '{value}' } }),
      series: [{
        name: '行驶里程', type: 'bar', data: vals,
        barMaxWidth: 24,
        itemStyle: { color: cssVar('--series-1'), borderRadius: [4, 4, 0, 0] },
      }],
    }), { notMerge: true });
  }

  function renderCharging() {
    const o = S.overview;
    if (!o || !charts.charging || !o.chargingSessions) return;
    const sess = o.chargingSessions.slice().reverse();
    // 用户录入的费用优先于库内 cost
    const enteredCost = {};
    ((o.costs || {}).charges || []).forEach((c) => {
      if (c.cost !== null && c.cost !== undefined) enteredCost[c.id] = c.cost;
    });
    charts.charging.setOption(Object.assign({}, chartTheme(), {
      tooltip: {
        trigger: 'axis',
        backgroundColor: cssVar('--surface-1'),
        borderColor: cssVar('--border'), borderWidth: 1, padding: [8, 12],
        textStyle: { color: cssVar('--text-primary'), fontSize: 12 },
        axisPointer: { type: 'shadow', shadowStyle: { color: cssVar('--tile-track') } },
        formatter(params) {
          const p = params[0];
          const s = sess[p.dataIndex];
          const up = (s.start_battery_level !== null && s.end_battery_level !== null)
            ? Number(s.end_battery_level) - Number(s.start_battery_level) : null;
          return `<div style="color:${cssVar('--text-muted')};font-size:11px;margin-bottom:4px">${fmtTime(Number(s.start_date_ts), true)}</div>` +
                 `<div><span style="display:inline-block;width:14px;height:8px;border-radius:2px;` +
                 `background:${p.color};vertical-align:middle;margin-right:6px"></span>` +
                 `<b>${fmtNum(s.charge_energy_added, 1)} kWh</b> <span style="color:${cssVar('--text-muted')}">充电量</span></div>` +
                 `<div style="color:${cssVar('--text-muted')};margin-top:2px">` +
                 `${fmtNum(s.start_battery_level, 0)}% → ${fmtNum(s.end_battery_level, 0)}%` +
                 (up !== null ? ` (+${fmtNum(up, 0)}% ${kmSuffix(up)})` : '') +
                 ` · ${fmtNum(s.duration_min, 0)} 分钟` +
                 (enteredCost[s.id] !== undefined ? ` · ¥${fmtNum(enteredCost[s.id], 2)}`
                   : s.cost != null ? ` · ¥${fmtNum(s.cost, 2)}` : '') + '</div>';
        },
      },
      grid: { left: 8, right: 12, top: 24, bottom: 4, containLabel: true },
      xAxis: Object.assign(axisCommon(), { type: 'category',
        data: sess.map((s) => fmtTime(Number(s.start_date_ts)).slice(0, 5)),
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11 } }),
      yAxis: Object.assign(axisCommon(), { type: 'value',
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11, formatter: '{value}' } }),
      series: [{
        name: '充电量', type: 'bar',
        data: sess.map((s) => Number(s.charge_energy_added)),
        barMaxWidth: 24,
        itemStyle: { color: cssVar('--series-3'), borderRadius: [4, 4, 0, 0] },
      }],
    }), { notMerge: true });
  }

  /* ---------- 渲染:电量活动时间线(顶部全宽) ---------- */

  function stripSeries(name, data, tooltipBody) {
    // 泳道标注条:data = [laneIndex, startMs, endMs, color, meta]
    return {
      name, type: 'custom',
      xAxisIndex: 1, yAxisIndex: 1,
      data, animation: false,
      renderItem(params, api) {
        const lane = api.value(0);
        const x0 = api.coord([api.value(1), lane]);
        const x1 = api.coord([api.value(2), lane]);
        const yTop = api.coord([api.value(1), lane + 0.38]);
        const yBot = api.coord([api.value(1), lane - 0.38]);
        return {
          type: 'rect',
          shape: {
            x: x0[0],
            y: yBot[1],
            width: Math.max(x1[0] - x0[0], 2),
            height: yTop[1] - yBot[1],
          },
          style: { fill: api.value(3), opacity: 0.9 },
        };
      },
      encode: { x: [1, 2], y: 0 },
      tooltip: {
        trigger: 'item',
        backgroundColor: cssVar('--surface-1'),
        borderColor: cssVar('--border'),
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: cssVar('--text-primary'), fontSize: 12 },
        extraCssText: 'box-shadow: 0 4px 16px rgba(0,0,0,.18);border-radius:8px;',
        formatter(params) {
          return tooltipBody(params.data[4]);
        },
      },
    };
  }

  function activityDomain(a) {
    const nowMs = Date.now();
    const first = a.battery.length ? a.battery[0][0] : nowMs;
    return {
      min: Math.min(first, localMidnight(nowMs - S.days * 86400000)) - 3600000,
      max: nowMs + 60000,
    };
  }

  function renderActivity() {
    const o = S.overview;
    if (!o || !charts.activity || !o.activity) return;
    const a = o.activity;
    const domain = activityDomain(a);
    const batt = a.battery.map((p) => [Number(p[0]), Number(p[1])]);
    // 窄屏:y 轴标签绘制在图内,无需 96px 左边距,留出更多绘图区
    const narrow = isNarrow();
    // 电量 ⇄ 里程维度切换
    const fullKm = kmFull();
    const kmMode = S.battMode === 'km' && fullKm !== null;
    const battLine = kmMode
      ? batt.map(([t, p]) => [t, kmAtPct(p)]).filter((p) => p[1] !== null)
      : batt;

    // 每一天的分隔:本地零点竖虚线
    const midnights = [];
    for (let t = localMidnight(domain.min); t <= domain.max; t += 86400000) {
      midnights.push({ xAxis: t });
    }

    const stripData = [];
    const catColor = (c) => cssVar(CAT[c].colorVar);
    a.drives.forEach((d) => stripData.push([
      1, Number(d.start_date_ts), Number(d.end_date_ts), catColor('drive'),
      {
        kind: 'drive', s: Number(d.start_date_ts), e: Number(d.end_date_ts),
        title: '行驶', body: `${fmtNum(d.distance, 1)} km · ${fmtNum(d.duration_min, 0)} 分` +
          `${d.start_name || d.end_name ? ` · ${d.start_name || '—'} → ${d.end_name || '—'}` : ''}`,
      },
    ]));
    a.charges.forEach((c) => stripData.push([
      1, Number(c.start_date_ts), c.end_date_ts === null ? domain.max : Number(c.end_date_ts),
      catColor('charge'),
      {
        kind: 'charge', s: Number(c.start_date_ts),
        title: '充电', body: `${fmtNum(c.charge_energy_added, 1)} kWh · ` +
          `${fmtNum(c.start_battery_level, 0)}% → ${fmtNum(c.end_battery_level, 0)}%` +
          (c.start_battery_level !== null && c.end_battery_level !== null
            ? ` · 增加 ${kmSuffix(Number(c.end_battery_level) - Number(c.start_battery_level))}` : '') +
          (c.cost !== null && c.cost !== undefined ? ` · ¥${fmtNum(c.cost, 2)}` : '') +
          `${c.address_name ? ` · ${c.address_name}` : ''}`,
      },
    ]));
    a.sentry.forEach((p) => stripData.push([
      0, p.s, p.e, catColor('sentry'),
      {
        kind: 'sentry', s: p.s, e: p.e,
        title: '哨兵耗电', body: `${fmtNum(p.dur_min, 0)} 分钟 · 耗电 ${fmtNum(-p.delta, 0)}% ${kmSuffix(-p.delta)}` +
          (p.rate_pct_h !== null ? ` · 约 ${fmtNum(p.rate_pct_h, 2)} %/h` : ''),
      },
    ]));
    a.idle.forEach((p) => stripData.push([
      0, p.s, p.e, catColor('idle'),
      {
        kind: 'idle', s: p.s, e: p.e,
        title: p.kind === 'climate' ? '驻车耗电(空调)' : '驻车耗电(休眠)',
        body: `${fmtNum(p.dur_min, 0)} 分钟 · 耗电 ${fmtNum(-p.delta, 0)}% ${kmSuffix(-p.delta)}`,
      },
    ]));

    const stripTip = (m) =>
      `<div style="color:${cssVar('--text-muted')};font-size:11px;margin-bottom:4px">` +
      `${m.title} · ${fmtTime(m.s)} – ${fmtTime(m.e)}</div>` +
      `<div><b>${m.body}</b></div>`;

    charts.activity.setOption(Object.assign({}, chartTheme(), {
      animation: false,
      tooltip: tooltipAxis({ '电量': '%', '剩余里程(折算)': 'km' },
        (v) => fmtTime(v, true), dualBatt),
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: [
        { left: narrow ? 6 : 96, right: narrow ? 20 : 44, top: 30, bottom: '26%' },
        { left: narrow ? 6 : 96, right: narrow ? 20 : 44, top: '78%', bottom: '11%' },
      ],
      xAxis: [
        Object.assign(timeAxis(S.days), {
          min: domain.min, max: domain.max,
          axisLabel: { show: false },
          axisPointer: { label: { show: false } },
        }),
        Object.assign(timeAxis(S.days), {
          gridIndex: 1, min: domain.min, max: domain.max,
          axisPointer: { label: { show: false } },
        }),
      ],
      yAxis: [
        Object.assign(axisCommon(), {
          type: 'value', min: 0,
          max: kmMode ? Math.ceil(fullKm / 100) * 100 : 100,
          axisLabel: { color: cssVar('--text-muted'), fontSize: 11,
            formatter: kmMode ? '{value}' : '{value}%', inside: true },
        }),
        Object.assign(axisCommon(), {
          gridIndex: 1, type: 'value', min: 0, max: 2, interval: 0.5,
          splitLine: { show: false },
          axisLabel: {
            color: cssVar('--text-muted'), fontSize: 11, inside: true,
            formatter: (v) => (v === 1.5 ? '行驶 · 充电' : v === 0.5 ? '哨兵 · 驻车耗电' : ''),
          },
        }),
      ],
      series: [
        Object.assign(lineSeries(kmMode ? '剩余里程(折算)' : '电量', battLine,
          cssVar('--series-1')), {
          markLine: {
            silent: true, symbol: 'none',
            data: midnights,
            lineStyle: { color: cssVar('--baseline'), type: 'dashed', width: 1 },
            label: {
              show: S.days <= 7, position: 'insideEndTop',
              formatter: (p) => fmtTime(p.value).slice(0, 5),
              color: cssVar('--text-muted'), fontSize: 10,
              backgroundColor: cssVar('--surface-1'), padding: [1, 5], borderRadius: 4,
            },
          },
        }),
        stripSeries('活动', stripData, stripTip),
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], filterMode: 'none' },
        {
          type: 'slider', xAxisIndex: [0, 1], filterMode: 'none',
          bottom: 2, height: narrow ? 20 : 16,
          handleSize: narrow ? '130%' : '100%',
          moveHandleSize: narrow ? 10 : 7,
          borderColor: cssVar('--border'),
          backgroundColor: 'transparent',
          fillerColor: 'rgba(57,135,229,0.12)',
          handleStyle: { color: cssVar('--series-1') },
          moveHandleStyle: { color: cssVar('--baseline') },
          dataBackground: {
            lineStyle: { color: cssVar('--baseline') },
            areaStyle: { color: 'transparent' },
          },
          selectedDataBackground: {
            lineStyle: { color: cssVar('--series-1') },
            areaStyle: { color: 'rgba(57,135,229,0.12)' },
          },
          textStyle: { color: cssVar('--text-muted'), fontSize: 10 },
        },
      ],
    }), { notMerge: true });
  }

  /* ---------- 渲染:活动事件列表(可折叠) ---------- */

  function eventRows(a) {
    const evs = [];
    a.drives.forEach((d) => evs.push({
      kind: 'drive', s: Number(d.start_date_ts), e: Number(d.end_date_ts), meta: d,
    }));
    a.charges.forEach((c) => evs.push({
      kind: 'charge', s: Number(c.start_date_ts),
      e: c.end_date_ts === null ? Date.now() : Number(c.end_date_ts), meta: c,
    }));
    a.sentry.forEach((p) => evs.push({ kind: 'sentry', s: p.s, e: p.e, meta: p }));
    a.idle.forEach((p) => evs.push({ kind: 'idle', s: p.s, e: p.e, meta: p }));
    evs.sort((x, y) => y.s - x.s);

    const groups = new Map();
    evs.forEach((ev) => {
      const key = dayKey(ev.s);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ev);
    });
    return groups;
  }

  function eventTime(s, e) {
    const sameDay = dayKey(s) === dayKey(e);
    return sameDay
      ? `${fmtClock(s)} – ${fmtClock(e)}`
      : `${fmtTime(s).slice(0, 5)} ${fmtClock(s)} – ${fmtTime(e).slice(0, 5)} ${fmtClock(e)}`;
  }

  function eventDesc(ev) {
    const m = ev.meta;
    if (ev.kind === 'drive') {
      const delta = (m.start_ideal_range_km !== null && m.end_ideal_range_km !== null)
        ? Number(m.start_ideal_range_km) - Number(m.end_ideal_range_km) : null;
      const eff = (delta !== null && m.distance && o_kwh() > 0)
        ? delta * o_kwh() * 1000 / m.distance : null;
      return `${fmtNum(m.distance, 1)} km · ${fmtNum(m.duration_min, 0)} 分` +
        (eff !== null ? ` · 约 ${fmtNum(eff, 0)} Wh/km` : '') +
        (m.start_name || m.end_name ? ` · ${m.start_name || '—'} → ${m.end_name || '—'}` : '') +
        (m.cost_yuan !== null && m.cost_yuan !== undefined
          ? ` · 电费 ¥${fmtNum(m.cost_yuan, 2)}` +
            (m.cost_per_km_yuan !== null && m.cost_per_km_yuan !== undefined
              ? ` (¥${fmtNum(m.cost_per_km_yuan, 2)}/km)` : '') : '');
    }
    if (ev.kind === 'charge') {
      const up = (m.start_battery_level !== null && m.end_battery_level !== null)
        ? Number(m.end_battery_level) - Number(m.start_battery_level) : null;
      return `${fmtNum(m.charge_energy_added, 1)} kWh · ${fmtNum(m.duration_min, 0)} 分` +
        (up !== null ? ` · 电量 +${fmtNum(up, 0)}% ${kmSuffix(up)}` : '') +
        `${m.address_name ? ` · ${m.address_name}` : ''}` +
        (m.cost !== null && m.cost !== undefined ? ` · 费用 ¥${fmtNum(m.cost, 2)}` : '') +
        (m.rate_yuan_kwh !== null && m.rate_yuan_kwh !== undefined
          ? ` (¥${fmtNum(m.rate_yuan_kwh, 2)}/kWh)` : '');
    }
    const tag = m.kind === 'climate' ? '(空调)' : ev.kind === 'sentry' ? '' : '(休眠)';
    const body = `${fmtNum(m.dur_min, 0)} 分钟 · 耗电 ${fmtNum(-m.delta, 0)}% ${kmSuffix(-m.delta)}${tag}` +
      (ev.kind === 'sentry' && m.rate_pct_h !== null
        ? ` · 约 ${fmtNum(m.rate_pct_h, 2)} %/h` : '') +
      (m.cost_yuan !== null && m.cost_yuan !== undefined
        ? ` · 电费约 ¥${fmtNum(m.cost_yuan, 2)}` : '');
    return body;
  }

  function o_kwh() {
    return S.overview ? (S.overview.kwhPerIdealKm || 0) : 0;
  }

  function eventDelta(ev) {
    const m = ev.meta;
    if (ev.kind === 'charge') {
      const up = (m.start_battery_level !== null && m.end_battery_level !== null)
        ? Number(m.end_battery_level) - Number(m.start_battery_level) : null;
      return up === null ? null : { text: `+${fmtNum(up, 0)}%`, up: true };
    }
    if (ev.kind === 'drive') {
      const delta = (m.start_ideal_range_km !== null && m.end_ideal_range_km !== null)
        ? Number(m.start_ideal_range_km) - Number(m.end_ideal_range_km) : null;
      return delta === null ? null : { text: `-${fmtNum(delta, 1)} km`, up: false };
    }
    return { text: `-${fmtNum(-m.delta, 0)}%`, up: false };
  }

  function renderEvents() {
    const o = S.overview;
    const box = $('#events-list');
    if (!o || !o.activity) return;
    const a = o.activity;
    const groups = eventRows(a);
    box.textContent = '';

    if (!groups.size) {
      box.appendChild(el('div', 'events-empty', '所选时间范围内暂无活动数据'));
      return;
    }

    groups.forEach((evs, key) => {
      const isToday = key === dayKey(Date.now());
      const grp = el('div', 'day-group' + (isToday ? ' open' : ''));
      const head = el('button', 'day-head');
      head.type = 'button';
      head.appendChild(el('span', 'date', dayLabel(evs[0].s)));
      const summary = el('span', 'summary');
      ['drive', 'charge', 'sentry', 'idle'].forEach((k) => {
        const n = evs.filter((ev) => ev.kind === k).length;
        if (n) summary.appendChild(el('span', 'chip ' + CAT[k].cls,
          `${CAT[k].label} ${n}`));
      });
      head.appendChild(summary);
      head.appendChild(el('span', 'chev', '▾'));
      head.addEventListener('click', () => grp.classList.toggle('open'));
      grp.appendChild(head);

      const body = el('div', 'day-body');
      evs.forEach((ev) => {
        const row = el('div', 'ev-row');
        row.appendChild(el('span', 'ev-time', eventTime(ev.s, ev.e)));
        row.appendChild(el('span', 'ev-chip ' + CAT[ev.kind].cls, CAT[ev.kind].label));
        row.appendChild(el('span', 'ev-desc', eventDesc(ev)));
        const d = eventDelta(ev);
        row.appendChild(el('span', 'ev-delta' + (d && d.up ? ' up' : ''),
          d ? d.text : '—'));
        body.appendChild(row);
      });
      grp.appendChild(body);
      box.appendChild(grp);
    });
  }

  /* ---------- 渲染:哨兵时间轴与耗电曲线 ---------- */

  function renderSentry() {
    const o = S.overview;
    if (!o || !charts.sentryLanes || !charts.sentryDrain || !o.activity) return;
    const a = o.activity;
    const sentry = a.sentry || [];

    // 概览统计
    const stats = $('#sentry-stats');
    stats.textContent = '';
    const hours = sentry.reduce((s, p) => s + (p.e - p.s), 0) / 3600000;
    const drain = -sentry.reduce((s, p) => s + p.delta, 0);
    function stat(label, value, unit, extra) {
      const t = el('span', 'mini-stat');
      t.appendChild(el('span', '', label + ' '));
      const b = el('b', '', fmtNum(value, value < 10 ? 1 : 0));
      t.appendChild(b);
      if (unit) t.appendChild(el('span', '', ' ' + unit));
      if (extra) t.appendChild(el('span', '', ' ' + extra));
      stats.appendChild(t);
    }
    stat('哨兵总时长', hours, '小时');
    stat('哨兵耗电', drain, '%', kmSuffix(drain));
    stat('平均耗电速率', hours > 0 ? drain / hours : 0, '%/h');
    stat('哨兵时段数', sentry.length, '');

    // 按天拆分哨兵时段(跨零点切开)
    const byDay = new Map();
    sentry.forEach((p) => {
      let cur = p.s;
      while (cur < p.e) {
        const ds = localMidnight(cur);
        const de = ds + 86400000;
        const segEnd = Math.min(p.e, de);
        const frac = (segEnd - cur) / (p.e - p.s);
        const key = dayKey(ds);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push({
          s: cur, e: segEnd,
          delta: Math.round(p.delta * frac),
          dur_min: Math.round(p.dur_min * frac),
          rate_pct_h: p.rate_pct_h,
        });
        cur = de;
      }
    });
    const domain = activityDomain(a);
    const days = [];
    for (let t = localMidnight(domain.max); t >= localMidnight(domain.min); t -= 86400000) {
      days.push({ key: dayKey(t), ms: t });
    }
    const laneData = [];
    days.forEach((d, idx) => {
      (byDay.get(d.key) || []).forEach((seg) => {
        laneData.push([idx, (seg.s - d.ms) / 3600000, (seg.e - d.ms) / 3600000,
          cssVar('--cat-sentry'), { d, seg }]);
      });
    });
    const laneH = Math.min(Math.max(days.length * 26 + 56, 170), 540);
    $('#chart-sentry-lanes').style.height = laneH + 'px';

    charts.sentryLanes.setOption(Object.assign({}, chartTheme(), {
      animation: false,
      tooltip: {
        trigger: 'item',
        backgroundColor: cssVar('--surface-1'),
        borderColor: cssVar('--border'), borderWidth: 1, padding: [8, 12],
        textStyle: { color: cssVar('--text-primary'), fontSize: 12 },
        extraCssText: 'box-shadow: 0 4px 16px rgba(0,0,0,.18);border-radius:8px;',
        formatter(params) {
          const m = params.data[4];
          const hh = (x) => `${String(Math.floor(x)).padStart(2, '0')}:${String(Math.floor(x % 1 * 60)).padStart(2, '0')}`;
          return `<div style="color:${cssVar('--text-muted')};font-size:11px;margin-bottom:4px">` +
            `${dayLabel(m.d.ms)} · 哨兵开启</div>` +
            `<div><b>${hh((m.seg.s - m.d.ms) / 3600000)} – ${hh((m.seg.e - m.d.ms) / 3600000)}</b></div>` +
            `<div style="color:${cssVar('--text-secondary')};margin-top:2px">` +
            `约 ${fmtNum(m.seg.dur_min, 0)} 分钟 · 耗电 ${fmtNum(-m.seg.delta, 0)}% ${kmSuffix(-m.seg.delta)}` +
            (m.seg.rate_pct_h !== null ? ` · ${fmtNum(m.seg.rate_pct_h, 2)} %/h` : '') + `</div>`;
        },
      },
      grid: { left: 8, right: 20, top: 24, bottom: 4, containLabel: true },
      xAxis: Object.assign(axisCommon(), { type: 'value', min: 0, max: 24, interval: 3,
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11, formatter: '{value}:00' } }),
      yAxis: Object.assign(axisCommon(), {
        type: 'category', inverse: true, data: days.map((d) => dayLabel(d.ms)),
        splitLine: { show: false },
        axisLabel: { color: cssVar('--text-secondary'), fontSize: 11 },
      }),
      series: [{
        name: '哨兵', type: 'custom', data: laneData,
        renderItem(params, api) {
          const idx = api.value(0);
          const x0 = api.coord([api.value(1), idx]);
          const x1 = api.coord([api.value(2), idx]);
          const band = api.size([0, 1]);
          const laneHpx = Math.min(Math.max(band[1] * 0.62, 6), 22);
          return {
            type: 'rect',
            shape: {
              x: x0[0], y: x0[1] - laneHpx / 2,
              width: Math.max(x1[0] - x0[0], 2), height: laneHpx,
            },
            style: { fill: api.value(3), opacity: 0.9 },
          };
        },
        encode: { x: [1, 2], y: 0 },
      }],
    }), { notMerge: true });

    // 哨兵耗电曲线:仅取哨兵时段内的电量采样,时段间断开
    const fullKm = kmFull();
    const kmMode = S.battMode === 'km' && fullKm !== null;
    const drainData = [];
    sentry.forEach((p) => {
      for (const [t, l] of a.battery) {
        if (t >= p.s && t <= p.e) drainData.push(kmMode ? [t, kmAtPct(l)] : [t, l]);
      }
    });
    charts.sentryDrain.setOption(Object.assign({}, chartTheme(), {
      animation: false,
      tooltip: tooltipAxis({ '电量': '%', '剩余里程(折算)': 'km' },
        (v) => fmtTime(v, true), dualBatt),
      grid: trendGrid(24),
      xAxis: Object.assign(timeAxis(S.days), { min: domain.min, max: domain.max }),
      yAxis: Object.assign(axisCommon(), { type: 'value', scale: true,
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11,
          formatter: kmMode ? '{value}' : '{value}%' } }),
      series: [Object.assign(lineSeries(kmMode ? '剩余里程(折算)' : '电量', drainData,
        cssVar('--series-1')), {
        connectNulls: false,
      })],
      dataZoom: [{ type: 'inside', filterMode: 'none' }],
    }), { notMerge: true });
  }

  /* ---------- 渲染:平均能耗 / 胎压 ---------- */

  function renderEfficiency() {
    const o = S.overview;
    if (!o || !charts.efficiency || !o.efficiency) return;
    const pts = (o.efficiency.points || []).map((p) => [Number(p.start_ts), p.eff_wh_km]);
    // 滑动平均(最近 7 次行程,不足则按已有次数)
    const ma = pts.map((_, i) => {
      const w = pts.slice(Math.max(0, i - 6), i + 1);
      return [pts[i][0], w.reduce((s, p) => s + p[1], 0) / w.length];
    });
    const effTip = (params) => {
      const p0 = params[0];
      let s = `<div style="color:${cssVar('--text-muted')};font-size:11px;margin-bottom:4px">` +
              fmtTime(p0.axisValue, true) + '</div>';
      params.forEach((p) => {
        s += `<div style="line-height:1.7"><span style="display:inline-block;width:14px;height:2px;` +
             `background:${p.color};vertical-align:middle;margin-right:6px"></span>` +
             `<b>${fmtNum(p.value[1], 0)} Wh/km</b> <span style="color:${cssVar('--text-muted')}">${p.seriesName}</span></div>`;
      });
      const d = o.efficiency.points.find((x) => x.start_ts === Number(p0.axisValue));
      if (d) {
        s += `<div style="color:${cssVar('--text-muted')};margin-top:2px">` +
             `${fmtNum(d.distance, 1)} km · ${fmtNum(d.duration_min, 0)} 分` +
             (d.start_name || d.end_name ? ` · ${d.start_name || '—'} → ${d.end_name || '—'}` : '') + '</div>';
      }
      return s;
    };
    charts.efficiency.setOption(Object.assign({}, chartTheme(), {
      tooltip: Object.assign(tooltipAxis({}, (v) => fmtTime(v, true)), { formatter: effTip }),
      legend: {
        top: 0, left: 6, itemWidth: 14, itemHeight: 8, itemGap: isNarrow() ? 10 : 14,
        textStyle: { color: cssVar('--text-secondary'), fontSize: 12 },
      },
      grid: trendGrid(34),
      xAxis: timeAxis(S.days),
      yAxis: Object.assign(axisCommon(), { type: 'value', min: 0,
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11, formatter: '{value}' } }),
      series: [
        {
          name: '单次行程', type: 'scatter', data: pts, symbolSize: 9,
          itemStyle: {
            color: cssVar('--series-1'),
            borderColor: cssVar('--surface-1'), borderWidth: 2,
          },
        },
        Object.assign(lineSeries('滑动平均(7 次)', ma, cssVar('--series-2')), {
          symbol: 'none',
          endLabel: {
            show: true, formatter: (p) => fmtNum(p.value[1], 0),
            color: cssVar('--text-secondary'), fontSize: 11,
            backgroundColor: cssVar('--surface-1'), padding: [2, 5], borderRadius: 4,
          },
        }),
      ],
    }), { notMerge: true });
  }

  function renderTpms() {
    const o = S.overview;
    if (!o || !charts.tpms || !o.tpms) return;
    const w = o.tpms.wheels || {};
    const names = [
      ['fl', '左前'], ['fr', '右前'], ['rl', '左后'], ['rr', '右后'],
    ];
    charts.tpms.setOption(Object.assign({}, chartTheme(), {
      tooltip: tooltipAxis({ '左前': 'bar', '右前': 'bar', '左后': 'bar', '右后': 'bar' },
        (v) => fmtTime(v, true)),
      legend: {
        top: 0, left: 6, itemWidth: 14, itemHeight: 8, itemGap: isNarrow() ? 10 : 14,
        textStyle: { color: cssVar('--text-secondary'), fontSize: 12 },
      },
      grid: trendGrid(34),
      xAxis: timeAxis(S.days),
      yAxis: Object.assign(axisCommon(), { type: 'value', scale: true,
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11, formatter: '{value}' } }),
      series: names.map(([key, label], i) =>
        lineSeries(label, (w[key] || []).map((p) => [Number(p[0]), Number(p[1])]),
          cssVar(`--series-${i + 1}`))),
    }), { notMerge: true });
  }

  /* ---------- 渲染:车内 / 车外温度 ---------- */

  function renderTemp() {
    const o = S.overview;
    if (!o || !charts.temp || !o.temp) return;
    const mk = (arr) => (arr || []).map((p) => [Number(p[0]), Number(p[1])]);
    charts.temp.setOption(Object.assign({}, chartTheme(), {
      tooltip: tooltipAxis({ '车内': '°C', '车外': '°C' }, (v) => fmtTime(v, true)),
      legend: {
        top: 0, left: 6, itemWidth: 14, itemHeight: 8, itemGap: isNarrow() ? 10 : 14,
        textStyle: { color: cssVar('--text-secondary'), fontSize: 12 },
      },
      grid: trendGrid(34),
      xAxis: timeAxis(S.days),
      yAxis: Object.assign(axisCommon(), {
        type: 'value', scale: true,
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11, formatter: '{value}°' },
      }),
      series: [
        // 车内暖色 / 车外冷色(参考调色板 series-2 橙 / series-1 蓝)
        lineSeries('车内', mk(o.temp.inside), cssVar('--series-2')),
        lineSeries('车外', mk(o.temp.outside), cssVar('--series-1')),
      ],
    }), { notMerge: true });
  }

  /* ---------- 渲染:车辆总览(俯视图 + 能耗占比 + 四轮胎压 + 电池健康) ---------- */

  // 本卡片独立的三态切换:电量 % / 度数 kWh / 里程 km
  function carModeEffective() {
    if (S.carMode === 'km' && kmFull() === null) return 'pct';
    return S.carMode;
  }

  // 电池 % → 当前展示单位(cap 为该充电周期估算的满电容量)
  function carConvPct(pct, cap) {
    const mode = carModeEffective();
    if (mode === 'kwh') return { v: pct / 100 * cap, unit: 'kWh', dec: 1 };
    if (mode === 'km') {
      const f = kmFull();
      return { v: f ? pct / 100 * f : null, unit: 'km', dec: 0 };
    }
    return { v: pct, unit: '%', dec: 0 };
  }

  // 车身坐标系:viewBox 0 0 340 460,车头(上)=100% 满电端,车尾(下)=0%
  const CARY = (p) => 436 - 4.12 * p;

  // 分段点选:车身分带 ⇄ 图例详情 联动高亮(再点一次或点空白处取消)
  let carSel = null;
  function setCarSel(k) {
    carSel = k || null;
    document.querySelectorAll('.car-svg rect[id^="carfill-"]').forEach((r) => {
      r.classList.toggle('dim', !!carSel && r.id !== `carfill-${carSel}`);
    });
    document.querySelectorAll('.cl-item').forEach((d) =>
      d.classList.toggle('on', !!carSel && d.dataset.k === carSel));
    const cv = $('.carview');
    if (cv) cv.classList.toggle('has-sel', !!carSel);
  }

  function renderCar() {
    const o = S.overview;
    if (!o) return;

    /* --- 能量占比:车身纵向分带(按充电周期:充电结束 → 下次充电开始/现在) --- */
    const cycles = (S.cycles && S.cycles.cycles) || [];
    S.cycleIdx = Math.min(S.cycleIdx, Math.max(0, cycles.length - 1));
    const cyc = cycles.length ? cycles[S.cycleIdx] : null;

    // 充电周期横条:每个周期一枚可点选芯片(横向滑动),条内小进度条为充至电量
    const strip = $('#cycle-strip');
    strip.hidden = !cycles.length;
    const sig = cycles.map((c) => `${c.charge_id}:${c.level_after}:${c.charge_count}`).join(',');
    if (strip.dataset.sig !== sig) {
      strip.dataset.sig = sig;
      strip.textContent = '';
      cycles.forEach((c, i) => {
        const b = el('button', 'cyc-chip');
        b.type = 'button';
        b.dataset.idx = i;
        b.appendChild(el('b', '', `${fmtTime(Number(c.charge_end_ts))} 充至 ${fmtNum(c.level_after, 0)}%`));
        const parts = [];
        if (c.charge_count > 1) parts.push(`合并${c.charge_count}次`);
        if (c.active) parts.push('进行中');
        if (parts.length) b.appendChild(el('span', 'cyc-sub', parts.join(' · ')));
        const bar = el('span', 'cyc-bar');
        const fill = el('i');
        fill.style.width = Math.max(0, Math.min(100, Number(c.level_after))) + '%';
        bar.appendChild(fill);
        b.appendChild(bar);
        strip.appendChild(b);
      });
    }
    strip.querySelectorAll('.cyc-chip').forEach((b) =>
      b.classList.toggle('on', Number(b.dataset.idx) === S.cycleIdx));

    const SEG_IDS = ['#carfill-uncharged', '#carfill-idle', '#carfill-climate',
      '#carfill-sentry', '#carfill-drive', '#carfill-remaining'];
    const SEP_IDS = ['#carsep-1', '#carsep-2', '#carsep-3', '#carsep-4', '#carsep-5'];
    if (!cyc) {
      SEG_IDS.forEach((id) => {
        const r = $(id);
        if (r) { r.setAttribute('y', 24); r.setAttribute('height', 0); }
      });
      SEP_IDS.forEach((id) => {
        const l = $(id);
        if (l) { l.setAttribute('y1', 24); l.setAttribute('y2', 24); }
      });
    } else {
      // 车头侧斜纹 = 本次未充(100% − 充至电量);充入区各段按估算值归一化填满
      const inner = [
        ['uncharged', Number(cyc.uncharged_pct), true],
        ['idle', Number(cyc.idle_pct), false],
        ['climate', Number(cyc.climate_pct), false],
        ['sentry', Number(cyc.sentry_pct), false],
        ['drive', Number(cyc.drive_pct), false],
        ['remaining', Number(cyc.remaining_pct), false],
      ];
      const normSum = inner.slice(1).reduce((s, x) => s + x[1], 0);
      const scale = normSum > 0 ? cyc.level_after / normSum : 0;
      let cum = 100;
      const boundsY = [];
      inner.forEach(([k, v, raw], i) => {
        const frac = raw ? v : v * scale;
        const y1 = CARY(cum);
        cum -= frac;
        const y2 = CARY(cum);
        const r = $(`#carfill-${k}`);
        r.setAttribute('y', y1.toFixed(1));
        r.setAttribute('height', Math.max(0, y2 - y1).toFixed(1));
        if (i < inner.length - 1) boundsY.push(y2);
      });
      SEP_IDS.forEach((id, i) => {
        const l = $(id);
        if (!l) return;
        l.setAttribute('y1', boundsY[i].toFixed(1));
        l.setAttribute('y2', boundsY[i].toFixed(1));
      });
    }

    /* --- 两侧图例:左列 未充/驻车耗电/驻车空调,右列 哨兵/行驶/剩余 --- */
    const cap = cyc && cyc.cap_kwh ? Number(cyc.cap_kwh) : 84;
    const itemsL = [
      { k: 'uncharged', name: '本次未充', pct: cyc ? Number(cyc.uncharged_pct) : null, hatch: true },
      { k: 'idle', name: '驻车耗电', pct: cyc ? Number(cyc.idle_pct) : null, color: 'var(--cat-idle)' },
      { k: 'climate', name: '驻车空调', pct: cyc ? Number(cyc.climate_pct) : null, color: 'var(--series-4)' },
    ];
    const itemsR = [
      { k: 'sentry', name: '哨兵', pct: cyc ? Number(cyc.sentry_pct) : null, color: 'var(--cat-sentry)' },
      { k: 'drive', name: '行驶', pct: cyc ? Number(cyc.drive_pct) : null, color: 'var(--cat-drive)' },
      { k: 'remaining', name: cyc && !cyc.active ? '周期末剩余' : '当前剩余',
        pct: cyc ? Number(cyc.remaining_pct) : null, color: 'var(--series-1)' },
    ];
    const fillCol = (id, items) => {
      const box = $(id);
      box.textContent = '';
      items.forEach((it) => {
        const d = el('div', 'cl-item');
        d.dataset.k = it.k;
        d.style.setProperty('--cl-c', it.color || 'var(--baseline)');
        if (carSel === it.k) d.classList.add('on');
        const dot = el('span', 'cl-dot' + (it.hatch ? ' dot-hatch' : ''));
        if (it.color) dot.style.background = it.color;
        d.appendChild(dot);
        const tx = el('div');
        tx.appendChild(el('b', '', it.name));
        if (it.pct === null || carModeEffective() === 'pct') {
          tx.appendChild(el('span', 'cl-val', it.pct === null ? '—' : `${fmtNum(it.pct, 1)}%`));
        } else {
          const conv = carConvPct(it.pct, cap);
          tx.appendChild(el('span', 'cl-val',
            conv.v === null ? '—' : `${fmtNum(conv.v, conv.dec)} ${conv.unit}`));
          tx.appendChild(el('span', 'cl-sub', `${fmtNum(it.pct, 1)}%`));
        }
        d.appendChild(tx);
        box.appendChild(d);
      });
    };
    fillCol('#car-legend-l', itemsL);
    fillCol('#car-legend-r', itemsR);


    /* --- 电池健康 --- */
    const stats = $('#car-health-stats');
    stats.textContent = '';
    const h = S.health;
    if (h && h.health_pct !== null && h.health_pct !== undefined) {
      const mk = (label, value, unit) => {
        const t = el('span', 'mini-stat');
        t.appendChild(el('span', '', label + ' '));
        t.appendChild(el('b', '', String(value)));
        if (unit) t.appendChild(el('span', '', ' ' + unit));
        return t;
      };
      stats.appendChild(mk('电池健康度', fmtNum(h.health_pct, 1), '%'));
      stats.appendChild(mk('满电估算', fmtNum(h.current_kwh, 1), 'kWh'));
    }
    if (charts.health) {
      const pts = (h && h.points ? h.points : []).map((p) => [Number(p.ts), p.kwh]);
      charts.health.setOption(Object.assign({}, chartTheme(), {
        animation: false,
        tooltip: tooltipAxis({ '满电容量估算': 'kWh' }, (v) => fmtTime(v)),
        grid: { left: 8, right: 14, top: 14, bottom: 4, containLabel: true },
        xAxis: Object.assign(timeAxis(30), { min: 'dataMin', max: 'dataMax' }),
        yAxis: Object.assign(axisCommon(), {
          type: 'value', scale: true,
          axisLabel: { color: cssVar('--text-muted'), fontSize: 11, formatter: '{value}' },
        }),
        series: [{
          name: '满电容量估算', type: 'line', data: pts,
          smooth: 0.3, symbolSize: 6,
          lineStyle: { width: 2, color: cssVar('--series-3') },
          itemStyle: { color: cssVar('--series-3') },
          areaStyle: { color: cssVar('--series-3') + '1f' },
          markLine: h && h.nominal_kwh ? {
            silent: true, symbol: 'none',
            data: [{ yAxis: h.nominal_kwh }],
            lineStyle: { color: cssVar('--text-muted'), type: 'dashed', width: 1 },
            label: {
              formatter: `基准 ${fmtNum(h.nominal_kwh, 1)} kWh`,
              color: cssVar('--text-muted'), fontSize: 10, position: 'insideEndTop',
            },
          } : undefined,
        }],
        graphic: pts.length ? [] : [{
          type: 'text', left: 'center', top: 'middle',
          style: { text: '暂无充电数据,无法估算', fill: cssVar('--text-muted'), fontSize: 12 },
        }],
      }), { notMerge: true });
    }

    /* --- 四轮胎压:当前值 + 迷你平滑填充曲线 --- */
    const w = (o.tpms && o.tpms.wheels) || {};
    const wheels = [
      ['fl', 'wfl', '--series-1'], ['fr', 'wfr', '--series-2'],
      ['rl', 'wrl', '--series-3'], ['rr', 'wrr', '--series-4'],
    ];
    wheels.forEach(([key, cid, colorVar]) => {
      const data = (w[key] || []).map((p) => [Number(p[0]), Number(p[1])]);
      const valEl = $(`#tpms-val-${key}`);
      if (valEl) valEl.textContent = data.length ? fmtNum(data[data.length - 1][1], 1) : '—';
      // 胎压上报量化为 0.1 bar 的阶梯:9 点滑动平均后再平滑,视觉上更柔和
      const sm = data.map((p, i) => {
        let s = 0, n = 0;
        for (let j = Math.max(0, i - 4); j <= Math.min(data.length - 1, i + 4); j++) {
          s += data[j][1]; n++;
        }
        return [p[0], Math.round(s / n * 100) / 100];
      });
      const ch = charts[cid];
      if (!ch) return;
      const color = cssVar(colorVar);
      ch.setOption(Object.assign({}, chartTheme(), {
        animation: false,
        tooltip: {
          trigger: 'axis',
          backgroundColor: cssVar('--surface-1'),
          borderColor: cssVar('--border'), borderWidth: 1, padding: [5, 9],
          textStyle: { color: cssVar('--text-primary'), fontSize: 11 },
          extraCssText: 'box-shadow: 0 4px 16px rgba(0,0,0,.18);border-radius:8px;',
          formatter(params) {
            const p = params[0];
            return `<div style="color:${cssVar('--text-muted')};font-size:10px">${fmtTime(p.value[0], true)}</div>` +
                   `<b>${fmtNum(p.value[1], 1)} bar</b>`;
          },
        },
        grid: { left: 2, right: 2, top: 3, bottom: 2 },
        xAxis: { type: 'time', show: false },
        yAxis: { type: 'value', show: false, scale: true },
        series: [{
          type: 'line', data: sm, smooth: true, smoothMonotone: 'x', showSymbol: false,
          lineStyle: { width: 1.6, color, cap: 'round' },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: color + '59' },
              { offset: 1, color: color + '0a' },
            ]),
          },
        }],
      }), { notMerge: true });
    });
  }

  /* ---------- 渲染:行程表 ---------- */

  function renderTable() {
    const o = S.overview;
    if (!o) return;
    const tbl = $('#drives-table');
    tbl.textContent = '';
    const rows = o.recentDrives || [];

    const thead = el('thead');
    const hr = el('tr');
    ['出发时间', '起点', '终点', '距离', '时长', '均速', '最高速', '能耗', 'Δ理想续航']
      .forEach((h, i) => hr.appendChild(el('th', i > 2 ? 'num' : '', h)));
    thead.appendChild(hr);
    tbl.appendChild(thead);

    if (!rows.length) {
      const td = el('td', 'empty', '暂无行程数据');
      td.colSpan = 9;
      const tr = el('tr'); tr.appendChild(td);
      tbl.appendChild(tr);
      return;
    }

    const tbody = el('tbody');
    rows.forEach((r) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'strong', fmtTime(Number(r.start_date_ts))));
      tr.appendChild(el('td', '', r.start_name || r.start_city || '—'));
      tr.appendChild(el('td', '', r.end_name || r.end_city || '—'));
      tr.appendChild(el('td', 'num strong', fmtNum(r.distance, 1)));
      tr.appendChild(el('td', 'num', r.duration_min ? `${fmtNum(r.duration_min, 0)} 分` : '—'));
      const avg = r.duration_min && r.distance ? r.distance / (r.duration_min / 60) : null;
      tr.appendChild(el('td', 'num', fmtNum(avg, 0)));
      tr.appendChild(el('td', 'num', fmtNum(r.speed_max, 0)));
      tr.appendChild(el('td', 'num', r.efficiency_wh_km === null || r.efficiency_wh_km === undefined
        ? '—' : fmtNum(r.efficiency_wh_km, 0)));
      tr.appendChild(el('td', 'num', r.ideal_delta_km === null || r.ideal_delta_km === undefined
        ? '—' : fmtNum(r.ideal_delta_km, 1)));
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
  }

  /* ---------- 渲染:充电详情(卡片式,纵向布局,适配手机) ---------- */

  function fmtDur(min) {
    const m = Number(min);
    if (!m || m <= 0) return '—';
    if (m < 60) return `${fmtNum(m, 0)} 分`;
    return `${Math.floor(m / 60)} 小时 ${fmtNum(m % 60, 0)} 分`;
  }

  // 保存后定向刷新:sessions 必刷;费用变动还要同步旧费用表与活动事件的金额
  async function csRefresh(withCosts) {
    const reqs = [api(`charging/sessions?days=${S.days}`)];
    if (withCosts) reqs.push(api('charging/costs?days=90'), api(`activity?days=${S.days}`));
    const [sessions, costs, act] = await Promise.all(reqs);
    S.sessions = sessions;
    if (withCosts) {
      S.overview.costs = costs;
      S.overview.activity = act;
    }
    renderSessions();
    renderChargers();
    if (withCosts) { renderCosts(); renderEvents(); renderActivity(); }
  }

  async function csSave(path, body, inps, withCosts) {
    try {
      await fetchJSON(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await csRefresh(withCosts);
    } catch (err) {
      console.error(err);
      (inps || []).forEach((inp) => {
        inp.disabled = false;
        inp.value = inp.dataset.orig || '';
        inp.title = '保存失败,请重试';
      });
    }
  }

  function renderSessions() {
    const box = $('#cs-list');
    if (!box || !S.sessions) return;
    box.textContent = '';
    const charges = S.sessions.charges || [];

    // 概览统计
    const stats = $('#cs-stats');
    stats.textContent = '';
    const stat = (label, value, unit) => {
      const t = el('span', 'mini-stat');
      t.appendChild(el('span', '', label + ' '));
      t.appendChild(el('b', '', String(value)));
      if (unit) t.appendChild(el('span', '', ' ' + unit));
      stats.appendChild(t);
    };
    if (charges.length) {
      stat('充电', charges.length, '次');
      const paid = charges.filter((c) => c.cost !== null && c.cost !== undefined);
      if (paid.length) {
        stat('费用合计', fmtNum(paid.reduce((s, c) => s + c.cost, 0), 2), '¥');
      }
    }
    if (!charges.length) {
      box.appendChild(el('div', 'empty', '所选时间范围内暂无充电记录'));
      return;
    }

    charges.forEach((c) => {
      const item = el('div', 'cs-item');

      /* 头部:充电时间(左)+ 充电桩名称/地点(右,可编辑,同地点自动带出) */
      const head = el('div', 'cs-head');
      const timeBox = el('div', 'cs-time');
      const sameDay = c.end_ts && dayKey(c.start_ts) === dayKey(c.end_ts);
      timeBox.appendChild(el('b', '', fmtTime(c.start_ts) +
        (c.end_ts ? ` → ${sameDay ? fmtClock(c.end_ts) : fmtTime(c.end_ts)}` : '')));
      if (!c.end_ts) timeBox.appendChild(el('span', 'cs-time-sub', '充电中'));
      head.appendChild(timeBox);

      const chg = el('div', 'cs-charger');
      if (c.charger_brand) chg.appendChild(el('span', 'cs-tag', c.charger_brand));
      const nameInp = el('input', 'cs-name-input');
      nameInp.type = 'text';
      nameInp.placeholder = '充电桩名称';
      nameInp.maxLength = 80;
      nameInp.value = c.charger_name || '';
      nameInp.dataset.orig = c.charger_name || '';
      const locInp = el('input', 'cs-loc-input');
      locInp.type = 'text';
      locInp.placeholder = c.loc_key ? '地点' : '地点(本次充电无地点信息,无法存档)';
      locInp.maxLength = 120;
      locInp.value = c.charger_location || '';
      locInp.dataset.orig = c.charger_location || '';
      const saveCharger = () => {
        const name = nameInp.value.trim();
        const loc = locInp.value.trim();
        if (name === nameInp.dataset.orig && loc === locInp.dataset.orig) return;
        nameInp.disabled = locInp.disabled = true;
        csSave('/api/charging/charger',
          { charge_id: c.id, name, location: loc }, [nameInp, locInp], false);
      };
      nameInp.addEventListener('change', saveCharger);
      locInp.addEventListener('change', saveCharger);
      chg.appendChild(nameInp);
      chg.appendChild(locInp);
      head.appendChild(chg);
      item.appendChild(head);

      /* 字段区:label + value,两列网格 */
      const fields = el('div', 'cs-fields');
      const field = (label, val) => {
        const f = el('div', 'cs-field');
        f.appendChild(el('span', 'cs-label', label));
        const v = el('span', 'cs-val');
        if (typeof val === 'string') v.textContent = val;
        else v.appendChild(val);
        f.appendChild(v);
        fields.appendChild(f);
      };
      const numInput = (placeholder) => {
        const inp = el('input', 'cost-input');
        inp.type = 'number';
        inp.min = '0';
        inp.step = '0.01';
        inp.inputMode = 'decimal';
        inp.placeholder = placeholder;
        return inp;
      };

      field('充电量', c.energy_kwh !== null && c.energy_kwh !== undefined
        ? `${fmtNum(c.energy_kwh, 2)} kWh` : '—');

      // 总耗电(桩端计费电量,含损耗):手填优先,未填显示车端记录值并标注
      const totalWrap = el('span', 'cs-inline');
      const totalInp = numInput('未填');
      if (c.total_kwh !== null && c.total_kwh !== undefined) totalInp.value = c.total_kwh;
      totalInp.dataset.orig = c.total_kwh !== null && c.total_kwh !== undefined
        ? String(c.total_kwh) : '';
      totalInp.addEventListener('change', () => {
        const raw = totalInp.value.trim();
        const v = raw === '' ? null : parseFloat(raw);
        if (raw !== '' && (isNaN(v) || v < 0 || v > 500)) {
          totalInp.value = totalInp.dataset.orig;
          return;
        }
        if ((v === null ? '' : String(v)) === totalInp.dataset.orig) return;
        totalInp.disabled = true;
        csSave('/api/charging/extras', { charge_id: c.id, total_kwh: v }, [totalInp], false);
      });
      totalWrap.appendChild(totalInp);
      totalWrap.appendChild(el('span', 'cs-unit', 'kWh'));
      if (c.total_kwh !== null && c.total_kwh !== undefined) {
        totalWrap.appendChild(el('span',
          c.total_kwh_manual ? 'cs-tag cs-tag-manual' : 'cs-tag',
          c.total_kwh_manual ? '手填' : '车端'));
      }
      field('总耗电', totalWrap);

      // 充电费用(与「充电费用」表共用同一份数据)
      const costWrap = el('span', 'cs-inline');
      const costInp = numInput('未填');
      if (c.cost !== null && c.cost !== undefined) costInp.value = c.cost;
      costInp.dataset.orig = c.cost !== null && c.cost !== undefined ? String(c.cost) : '';
      costInp.addEventListener('change', () => {
        const v = parseFloat(costInp.value);
        if (isNaN(v) || v < 0) {
          costInp.value = costInp.dataset.orig;
          return;
        }
        costInp.disabled = true;
        csSave('/api/charging/costs', { charge_id: c.id, cost: v }, [costInp], true);
      });
      costWrap.appendChild(costInp);
      costWrap.appendChild(el('span', 'cs-unit', '¥'));
      field('充电费用', costWrap);

      field('电费单价', c.rate_yuan_kwh !== null && c.rate_yuan_kwh !== undefined
        ? `¥${fmtNum(c.rate_yuan_kwh, 2)} /kWh` : '—');
      field('起止电量', (c.start_battery_level !== null && c.end_battery_level !== null
        && c.start_battery_level !== undefined && c.end_battery_level !== undefined)
        ? `${fmtNum(c.start_battery_level, 0)}% → ${fmtNum(c.end_battery_level, 0)}%` : '—');
      field('充电时长', fmtDur(c.duration_min));
      field('充电后行驶里程', `${fmtNum(c.after_km, 1)} km`);
      field('充电后每公里费用', c.per_km_yuan !== null && c.per_km_yuan !== undefined
        ? `¥${fmtNum(c.per_km_yuan, 2)} /km` : '—');

      item.appendChild(fields);
      box.appendChild(item);
    });
  }

  /* ---------- 渲染:充电桩统计(按桩聚合 sessions 数据,可展开详情) ---------- */

  const cgOpen = new Set();  // 展开的充电桩(按地点键),跨刷新保持展开状态

  function renderChargers() {
    const box = $('#cg-list');
    if (!box || !S.sessions) return;
    box.textContent = '';
    const charges = S.sessions.charges || [];
    if (!charges.length) {
      box.appendChild(el('div', 'empty', '所选时间范围内暂无充电记录'));
      return;
    }

    // 按地点键分组;无地点信息的会话无法跨次关联,归入「未记录地点」
    const agg = new Map();
    charges.forEach((c) => {
      const key = c.loc_key || 'noloc';
      const g = agg.get(key) || {
        key, name: '', location: '', brand: '', firstId: c.id, list: [],
        count: 0, energy: 0, dur: 0, cost: 0, hasCost: false,
        ePaired: 0, uPaired: 0,  // 仅「充电量与总耗电都有值」的会话参与损耗计算
      };
      if (!g.name && c.charger_name) g.name = c.charger_name;
      if (!g.location && c.charger_location) g.location = c.charger_location;
      if (!g.brand && c.charger_brand) g.brand = c.charger_brand;
      g.count += 1;
      if (c.energy_kwh !== null && c.energy_kwh !== undefined) g.energy += Number(c.energy_kwh);
      g.dur += Number(c.duration_min) || 0;
      if (c.cost !== null && c.cost !== undefined) { g.cost += Number(c.cost); g.hasCost = true; }
      if (c.energy_kwh != null && c.total_kwh != null && Number(c.total_kwh) > 0) {
        g.ePaired += Number(c.energy_kwh);
        g.uPaired += Number(c.total_kwh);
      }
      g.list.push(c);
      agg.set(key, g);
    });
    const rows = [...agg.values()].sort((a, b) => b.energy - a.energy);

    rows.forEach((g) => {
      const open = cgOpen.has(g.key);
      const item = el('div', open ? 'cg-item open' : 'cg-item');

      /* 汇总行(点击展开/收起) */
      const row = el('div', 'cg-row');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      const head = el('div', 'cg-head');
      const nameLine = el('div', 'cg-name');
      nameLine.appendChild(el('b', '', g.name || g.location || '未命名充电桩'));
      if (g.brand) nameLine.appendChild(el('span', 'cg-brand', g.brand));
      head.appendChild(nameLine);
      if (g.name && g.location) head.appendChild(el('span', 'cg-loc', g.location));
      row.appendChild(head);

      const stats = el('div', 'cg-stats');
      const chip = (label, value, cls) => {
        const t = el('span', ('cg-chip ' + (cls || '')).trim());
        t.appendChild(el('span', '', label + ' '));
        t.appendChild(el('b', '', value));
        stats.appendChild(t);
      };
      chip('充电', `${g.count} 次`);
      chip('充电量', `${fmtNum(g.energy, 1)} kWh`);
      chip('时长', fmtDur(g.dur));
      if (g.uPaired > 0) {
        const loss = g.uPaired - g.ePaired;
        const pct = loss / g.uPaired * 100;
        const cls = pct >= 10 ? 'cg-loss-high' : (pct < 5 ? 'cg-loss-low' : '');
        chip('损耗', `${fmtNum(pct, 1)}% (${fmtNum(loss, 1)} kWh)`, cls);
      } else {
        chip('损耗', '—');
      }
      if (g.hasCost) chip('费用', `¥${fmtNum(g.cost, 2)}`);
      row.appendChild(stats);
      row.appendChild(el('span', 'cg-arrow', '▸'));

      /* 详情(默认折叠):品牌填写 + 每次充电明细 */
      const detail = el('div', 'cg-detail');
      detail.hidden = !open;
      const toggle = () => {
        if (cgOpen.has(g.key)) cgOpen.delete(g.key);
        else cgOpen.add(g.key);
        const nowOpen = item.classList.toggle('open');
        detail.hidden = !nowOpen;
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
      item.appendChild(row);

      const brandRow = el('div', 'cg-brand-row');
      brandRow.appendChild(el('span', 'cs-label', '品牌'));
      const brandInp = el('input', 'cg-brand-input');
      brandInp.type = 'text';
      brandInp.maxLength = 40;
      brandInp.placeholder = g.key === 'noloc'
        ? '无地点信息,无法存档' : '如 特来电 / 星星充电 / 家充';
      brandInp.value = g.brand;
      brandInp.dataset.orig = g.brand;
      if (g.key === 'noloc') brandInp.disabled = true;
      brandInp.addEventListener('change', () => {
        const v = brandInp.value.trim();
        if (v === brandInp.dataset.orig) return;
        brandInp.disabled = true;
        // 借用该地点下任意一次充电的 id 定位地点键;名称/地点原样带上,服务端保留不覆盖
        csSave('/api/charging/charger',
          { charge_id: g.firstId, name: g.name, location: g.location, brand: v },
          [brandInp], false);
      });
      brandRow.appendChild(brandInp);
      detail.appendChild(brandRow);

      g.list.forEach((c) => {  // sessions 本身新的在前
        const line = el('div', 'cg-line');
        line.appendChild(el('b', '', fmtTime(c.start_ts)));
        const parts = [];
        if (c.energy_kwh !== null && c.energy_kwh !== undefined) {
          parts.push(`${fmtNum(c.energy_kwh, 1)} kWh`);
        }
        if (c.total_kwh !== null && c.total_kwh !== undefined) {
          parts.push(`总耗电 ${fmtNum(c.total_kwh, 1)}`);
        }
        if (c.total_kwh != null && c.energy_kwh != null && Number(c.total_kwh) > 0) {
          parts.push(`损耗 ${fmtNum((c.total_kwh - c.energy_kwh) / c.total_kwh * 100, 1)}%`);
        }
        parts.push(fmtDur(c.duration_min));
        if (c.cost !== null && c.cost !== undefined) parts.push(`¥${fmtNum(c.cost, 2)}`);
        line.appendChild(el('span', 'cg-line-sub', parts.join(' · ')));
        detail.appendChild(line);
      });
      item.appendChild(detail);
      box.appendChild(item);
    });
  }

  /* ---------- 渲染:充电费用 ---------- */

  async function saveChargeCost(id, cost, inp) {
    try {
      await fetchJSON('/api/charging/costs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ charge_id: id, cost }),
      });
      // 定向刷新:只重取费用与活动数据(避免地图 fitBounds 被重置)
      const [costs, act] = await Promise.all([
        api('charging/costs?days=90'),
        api(`activity?days=${S.days}`),
      ]);
      S.overview.costs = costs;
      S.overview.activity = act;
      renderCosts();
      renderEvents();
      renderActivity();
    } catch (err) {
      console.error(err);
      if (inp) {
        inp.disabled = false;
        inp.value = S.overview.costs.charges.find((c) => c.id === id)?.cost ?? '';
        inp.title = '保存失败,请重试';
      }
    }
  }

  function renderCosts() {
    const o = S.overview;
    const tbl = $('#costs-table');
    if (!o || !tbl || !o.costs) return;
    tbl.textContent = '';
    const charges = o.costs.charges || [];

    // 概览统计
    const stats = $('#cost-stats');
    stats.textContent = '';
    function stat(label, value, unit) {
      const t = el('span', 'mini-stat');
      t.appendChild(el('span', '', label + ' '));
      t.appendChild(el('b', '', String(value)));
      if (unit) t.appendChild(el('span', '', ' ' + unit));
      stats.appendChild(t);
    }
    const paid = charges.filter((c) => c.cost !== null && c.cost !== undefined);
    const totalCost = paid.reduce((s, c) => s + c.cost, 0);
    const totalEnergy = paid.reduce((s, c) => s + (c.energy_kwh || 0), 0);
    const a = o.activity || {};
    let evCost = 0, evCount = 0;
    (a.drives || []).forEach((d) => { if (d.cost_yuan != null) { evCost += d.cost_yuan; evCount++; } });
    (a.sentry || []).forEach((p) => { if (p.cost_yuan != null) { evCost += p.cost_yuan; evCount++; } });
    (a.idle || []).forEach((p) => { if (p.cost_yuan != null) { evCost += p.cost_yuan; evCount++; } });
    stat('已填费用', `${paid.length}/${charges.length}`, '次');
    stat('费用合计', fmtNum(totalCost, 2), '¥');
    if (totalEnergy > 0) stat('加权单价', fmtNum(totalCost / totalEnergy, 2), '¥/kWh');
    if (evCost > 0) stat(`${S.days} 天内耗电金额`, fmtNum(evCost, 2), '¥');
    if (!charges.length) {
      tbl.appendChild(el('div', 'empty', '暂无充电记录'));
      return;
    }

    const thead = el('thead');
    const hr = el('tr');
    ['充电时间', '充电量', '起止电量', '时长', '地点', '费用(¥)', '单价(¥/kWh)',
     '充电后行驶', '充电后电费', '充电后每公里'].forEach((h, i) =>
       hr.appendChild(el('th', i > 0 && i < 5 ? '' : 'num', h)));
    thead.appendChild(hr);
    tbl.appendChild(thead);

    const tbody = el('tbody');
    charges.forEach((c) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'strong', fmtTime(Number(c.start_ts), true)));
      tr.appendChild(el('td', 'num', fmtNum(c.energy_kwh, 1)));
      const lv = (c.start_battery_level !== null && c.end_battery_level !== null)
        ? `${fmtNum(c.start_battery_level, 0)}% → ${fmtNum(c.end_battery_level, 0)}%` : '—';
      tr.appendChild(el('td', 'num', lv));
      tr.appendChild(el('td', 'num', c.duration_min ? `${fmtNum(c.duration_min, 0)} 分` : '—'));
      tr.appendChild(el('td', '', c.address_name || '—'));
      const tdCost = el('td', 'num');
      const inp = el('input', 'cost-input');
      inp.type = 'number';
      inp.min = '0';
      inp.step = '0.01';
      inp.inputMode = 'decimal';
      inp.placeholder = '未填';
      if (c.cost !== null && c.cost !== undefined) inp.value = c.cost;
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        if (isNaN(v) || v < 0) {
          inp.value = c.cost !== null && c.cost !== undefined ? c.cost : '';
          return;
        }
        inp.disabled = true;
        saveChargeCost(c.id, v, inp);
      });
      tdCost.appendChild(inp);
      tr.appendChild(tdCost);
      tr.appendChild(el('td', 'num strong', c.rate_yuan_kwh != null ? fmtNum(c.rate_yuan_kwh, 2) : '—'));
      tr.appendChild(el('td', 'num', fmtNum(c.after_km, 1)));
      tr.appendChild(el('td', 'num', c.after_cost_yuan != null ? fmtNum(c.after_cost_yuan, 2) : '—'));
      tr.appendChild(el('td', 'num strong', c.after_per_km_yuan != null ? fmtNum(c.after_per_km_yuan, 2) : '—'));
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
  }

  /* ---------- 渲染:地图 ---------- */

  function initMap() {
    if (map) return;
    map = L.map('map', {
      zoomControl: true,
      attributionControl: true,
      // 触屏上禁用单指拖动,避免地图吞掉页面滚动;双指缩放仍可用,轨迹已 fitBounds 完整可见
      dragging: !L.Browser.mobile,
      tap: true,
    });
    // 瓦片走本站 /api/tiles/ 代理(手机直连 CDN 在国内网络下不稳);
    // 上游为 OSM 官方瓦片,深色主题用 CSS 滤镜反色(见 style.css .leaflet-tile-pane)
    const tileAttr = { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 贡献者', maxZoom: 19 };
    mapTiles.dark = L.tileLayer('/api/tiles/dark/{z}/{x}/{y}.png', tileAttr);
    mapTiles.light = L.tileLayer('/api/tiles/light/{z}/{x}/{y}.png', tileAttr);
    switchMapTheme();
  }

  function switchMapTheme() {
    if (!map) return;
    Object.values(mapTiles).forEach((t) => map.removeLayer(t));
    map.addLayer(S.theme === 'dark' ? mapTiles.dark : mapTiles.light);
  }

  let routesLayers = {};   // drive id -> polyline
  let routesBase = {};     // drive id -> 原始样式(用于取消选中恢复)
  let routeSig = null;     // 轨迹集合签名,不变则不重绘(避免 60s 刷新重置视野)
  let selectedRouteId = null;

  function renderRoutes() {
    const o = S.overview;
    if (!o || !o.routes) return;
    initMap();
    const routes = o.routes.routes || [];
    const sig = routes.map((r) => r.id).join(',');
    const totalKm = routes.reduce((s, r) => s + Number(r.distance || 0), 0);
    $('#routes-title').textContent = routes.length
      ? `${routes.length} 条轨迹 · 合计 ${fmtNum(totalKm, 1)} km · ` +
        `最近 ${fmtTime(Number(routes[routes.length - 1].start_date_ts), true)}`
      : '所选时间范围内暂无行程轨迹';
    if (sig === routeSig) return;  // 同一批轨迹:保留用户当前缩放/选择状态
    routeSig = sig;
    selectedRouteId = null;
    mapFit = false;
    routesLayers = {};
    routesBase = {};
    map.eachLayer((l) => {
      if (l.__ttvRoute) map.removeLayer(l);
    });

    const latestId = routes.length ? routes[routes.length - 1].id : null;
    let bounds = null;
    routes.forEach((r) => {
      const pts = (r.points || []).filter((p) => p.length === 2);
      if (pts.length < 2) return;
      const isLatest = r.id === latestId;
      const style = {
        color: cssVar(isLatest ? '--series-2' : '--series-1'),
        weight: isLatest ? 4 : 3,
        opacity: isLatest ? 1 : 0.7,
      };
      const line = L.polyline(pts, Object.assign({ lineCap: 'round', lineJoin: 'round' }, style));
      line.__ttvRoute = true;
      line.bindPopup(`<b>${fmtTime(Number(r.start_date_ts), true)}</b><br>` +
        `${fmtNum(r.distance, 1)} km · ${fmtNum(r.duration_min, 0)} 分` +
        (r.start_name || r.end_name ? `<br>${r.start_name || '—'} → ${r.end_name || '—'}` : ''));
      line.addTo(map);
      routesLayers[r.id] = line;
      routesBase[r.id] = style;
      bounds = bounds ? bounds.extend(line.getBounds()) : line.getBounds();
    });

    // 最近一次行程的起终点
    const last = routes[routes.length - 1];
    if (last && (last.points || []).length >= 2) {
      const p0 = last.points[0], p1 = last.points[last.points.length - 1];
      const mk = (p, fill) => L.circleMarker(p, {
        radius: 5, color: cssVar('--surface-1'), weight: 2, fillColor: fill, fillOpacity: 1,
      });
      mk(p0, cssVar('--series-1')).addTo(map).__ttvRoute = true;
      mk(p1, cssVar('--series-2')).addTo(map).__ttvRoute = true;
    }

    if (!mapFit && bounds) {
      map.fitBounds(bounds, { padding: [30, 30] });
      mapFit = true;
    }
  }

  function selectRoute(id) {
    const layer = routesLayers[id];
    if (!layer) return;
    Object.keys(routesLayers).forEach((k) => {
      const l = routesLayers[k];
      l.setStyle(Number(k) === id
        ? { color: cssVar('--seq-blue-500'), weight: routesBase[k].weight + 2, opacity: 1 }
        : routesBase[k]);
    });
    selectedRouteId = id;
    map.fitBounds(layer.getBounds(), { padding: [40, 40] });
  }

  function deselectRoute() {
    Object.keys(routesLayers).forEach((k) => {
      routesLayers[k].setStyle(routesBase[k]);
    });
    selectedRouteId = null;
  }

  function renderRoutesList() {
    const o = S.overview;
    const box = $('#routes-list');
    if (!o || !o.routes) return;
    box.textContent = '';
    const routes = [...(o.routes.routes || [])].reverse();  // 新的在前
    if (!routes.length) {
      box.appendChild(el('div', 'events-empty', '所选时间范围内暂无行程轨迹'));
      return;
    }
    const actById = {};
    ((S.overview.activity || {}).drives || []).forEach((d) => { actById[d.id] = d; });

    const groups = new Map();
    routes.forEach((r) => {
      const key = dayKey(Number(r.start_date_ts));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });

    groups.forEach((rs, key) => {
      const isToday = key === dayKey(Date.now());
      const grp = el('div', 'day-group' + (isToday ? ' open' : ''));
      const head = el('button', 'day-head');
      head.type = 'button';
      head.appendChild(el('span', 'date', dayLabel(Number(rs[0].start_date_ts))));
      const sum = el('span', 'summary');
      const km = rs.reduce((s, r) => s + Number(r.distance || 0), 0);
      sum.appendChild(el('span', 'chip', `${rs.length} 条轨迹 · ${fmtNum(km, 1)} km`));
      head.appendChild(sum);
      head.appendChild(el('span', 'chev', '▾'));
      head.addEventListener('click', () => grp.classList.toggle('open'));
      grp.appendChild(head);

      const body = el('div', 'day-body');
      rs.forEach((r) => {
        const row = el('div', 'rt-row');
        row.appendChild(el('span', 'rt-time', fmtClock(Number(r.start_date_ts))));
        row.appendChild(el('span', 'rt-names', `${r.start_name || '—'} → ${r.end_name || '—'}`));
        row.appendChild(el('span', 'rt-dist', `${fmtNum(r.distance, 1)} km`));
        row.appendChild(el('span', 'rt-dur', `${fmtNum(r.duration_min, 0)} 分`));
        row.appendChild(el('span', 'chev rt-chev', '▾'));

        const a = actById[r.id];
        const delta = (r.start_ideal_range_km !== null && r.end_ideal_range_km !== null)
          ? Number(r.start_ideal_range_km) - Number(r.end_ideal_range_km) : null;
        const eff = (delta !== null && delta > 0 && r.distance && o_kwh() > 0)
          ? delta * o_kwh() * 1000 / r.distance : null;
        const avg = (r.duration_min && r.distance)
          ? r.distance / (r.duration_min / 60) : null;
        const parts = [];
        if (avg !== null) parts.push(`均速 ${fmtNum(avg, 0)} km/h`);
        if (r.speed_max !== null && r.speed_max !== undefined) parts.push(`最高 ${fmtNum(r.speed_max, 0)} km/h`);
        if (eff !== null) parts.push(`能耗约 ${fmtNum(eff, 0)} Wh/km`);
        if (a && a.energy_kwh !== null && a.energy_kwh !== undefined) parts.push(`耗电约 ${fmtNum(a.energy_kwh, 1)} kWh`);
        if (delta !== null) parts.push(`Δ理想续航 ${fmtNum(delta, 1)} km`);
        if (a && a.cost_yuan !== null && a.cost_yuan !== undefined) {
          parts.push(`电费 ¥${fmtNum(a.cost_yuan, 2)}` +
            (a.cost_per_km_yuan !== null && a.cost_per_km_yuan !== undefined
              ? ` (¥${fmtNum(a.cost_per_km_yuan, 2)}/km)` : ''));
        }
        const detail = el('div', 'rt-detail', parts.length ? parts.join(' · ') : '无更多数据');
        row.addEventListener('click', () => {
          const open = row.classList.toggle('open');
          if (open) selectRoute(r.id);
          else if (selectedRouteId === r.id) deselectRoute();
        });
        body.appendChild(row);
        body.appendChild(detail);
      });
      grp.appendChild(body);
      box.appendChild(grp);
    });
  }

  /* ---------- 数据加载 ---------- */

  async function fetchJSON(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
  }

  function api(path) {
    const q = S.carId === null ? '' : (path.includes('?') ? '&' : '?') + 'car_id=' + S.carId;
    return fetchJSON('/api/' + path + q);
  }

  async function refresh() {
    try {
      const o = await api('overview');
      if (S.carId === null) S.carId = o.car_id;
      const [trend, daily, recent, chg, routes, act, eff, tpms, costs, sys, health, sessions, cyc, temp] = await Promise.all([
        api(`trend?days=${S.days}`),
        api(`drives/daily?days=${S.days}`),
        api('drives/recent?limit=10'),
        api('charging/summary?limit=12'),
        api(`routes?days=${S.days}`),
        api(`activity?days=${S.days}`),
        api(`efficiency/trend?days=${S.days}`),
        api(`tpms/trend?days=${S.days}`),
        api('charging/costs?days=90'),
        api('system'),
        api('battery/health'),
        api(`charging/sessions?days=${S.days}`),
        api('energy/cycles?limit=10'),
        api(`temp/trend?days=${S.days}`),
      ]);
      S.overview = {
        ...o,
        trendBattery: trend.battery,
        trendRange: trend.range,
        dailyRows: daily.days_rows,
        kwhPerIdealKm: recent.kwh_per_ideal_km,
        recentDrives: recent.drives,
        chargingSessions: chg.sessions,
        routes,
        activity: act,
        efficiency: eff,
        tpms,
        costs,
        temp,
      };
      S.health = health;
      S.sessions = sessions;
      S.cycles = cyc;
      $('#state-badge').dataset.state = 'unknown';
      renderSys(sys);
      renderHeader();
      renderCar();
      renderSessions();
      renderChargers();
      renderKpis();
      renderTrends();
      renderDaily();
      renderCharging();
      renderTable();
      renderRoutes();
      renderRoutesList();
      renderCosts();
      renderActivity();
      renderEvents();
      renderSentry();
      renderEfficiency();
      renderTpms();
      renderTemp();
    } catch (err) {
      $('#state-text').textContent = '数据连接失败';
      $('#updated-at').textContent = 'API 请求失败,稍后自动重试';
      console.error(err);
    }
  }

  function renderAll() {
    if (!S.overview) return;
    renderHeader(); renderKpis(); renderTrends();
    renderDaily(); renderCharging(); renderTable();
    renderRoutes(); renderRoutesList(); renderCosts();
    renderActivity(); renderEvents(); renderSentry();
    renderEfficiency(); renderTpms(); renderCar(); renderSessions(); renderChargers(); renderTemp();
  }

  /* ---------- 初始化 ---------- */

  function init() {
    applyTheme();
    charts.battery = echarts.init($('#chart-battery'));
    charts.range = echarts.init($('#chart-range'));
    charts.daily = echarts.init($('#chart-daily'));
    charts.charging = echarts.init($('#chart-charging'));
    charts.activity = echarts.init($('#chart-activity'));
    charts.sentryLanes = echarts.init($('#chart-sentry-lanes'));
    charts.sentryDrain = echarts.init($('#chart-sentry-drain'));
    charts.efficiency = echarts.init($('#chart-efficiency'));
    charts.tpms = echarts.init($('#chart-tpms'));
    charts.temp = echarts.init($('#chart-temp'));
    charts.health = echarts.init($('#chart-health'));
    charts.wfl = echarts.init($('#chart-wfl'));
    charts.wfr = echarts.init($('#chart-wfr'));
    charts.wrl = echarts.init($('#chart-wrl'));
    charts.wrr = echarts.init($('#chart-wrr'));

    // 车辆总览:电量 % / 度数 kWh / 里程 km 三态切换(本卡片独立,持久化)
    const carSeg = $('#car-mode-seg');
    carSeg.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('on', b.dataset.mode === S.carMode));
    carSeg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      S.carMode = b.dataset.mode;
      localStorage.setItem('ttv-car-mode', S.carMode);
      carSeg.querySelectorAll('button').forEach((x) =>
        x.classList.toggle('on', x === b));
      renderCar();
    });

    // 充电周期横条:点选芯片切换周期
    $('#cycle-strip').addEventListener('click', (e) => {
      const b = e.target.closest('.cyc-chip');
      if (!b) return;
      S.cycleIdx = Number(b.dataset.idx);
      renderCar();
      b.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    });

    // 俯视图分段 ⇄ 图例:点击互相定位高亮
    $('.car-svg').addEventListener('click', (e) => {
      const r = e.target.closest('rect[id^="carfill-"]');
      if (!r) { setCarSel(null); return; }
      const k = r.id.replace('carfill-', '');
      setCarSel(carSel === k ? null : k);
    });
    document.querySelectorAll('.car-legend').forEach((box) =>
      box.addEventListener('click', (e) => {
        const d = e.target.closest('.cl-item');
        if (!d) return;
        setCarSel(carSel === d.dataset.k ? null : d.dataset.k);
      }));

    $('#range-seg').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      document.querySelectorAll('#range-seg button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      S.days = Number(btn.dataset.days);
      refresh();
    });

    // 点击标题刷新;点击电量胶囊切换 电量 ⇄ 续航
    $('#title-refresh').addEventListener('click', refresh);
    const pill = $('#batt-pill');
    const togglePill = () => setBattMode(S.battMode === 'km' ? 'pct' : 'km');
    pill.addEventListener('click', togglePill);
    pill.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePill(); }
    });
    $('#theme-btn').addEventListener('click', () => {
      S.theme = S.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
    });

    // 电量 ⇄ 里程切换:所有切换控件共享一个模式(含 localStorage 持久化恢复)
    setBattMode(S.battMode);
    document.addEventListener('click', (e) => {
      const b = e.target.closest('.batt-toggle button');
      if (b) setBattMode(b.dataset.mode);
    });

    $('#events-toggle-btn').addEventListener('click', () => {
      const groups = document.querySelectorAll('#events-list .day-group');
      const anyClosed = Array.from(groups).some((g) => !g.classList.contains('open'));
      groups.forEach((g) => g.classList.toggle('open', anyClosed));
      $('#events-toggle-btn').textContent = anyClosed ? '全部收起' : '全部展开';
    });

    $('#routes-toggle-btn').addEventListener('click', () => {
      const groups = document.querySelectorAll('#routes-list .day-group');
      const anyClosed = Array.from(groups).some((g) => !g.classList.contains('open'));
      groups.forEach((g) => g.classList.toggle('open', anyClosed));
      $('#routes-toggle-btn').textContent = anyClosed ? '全部收起' : '全部展开';
    });

    window.addEventListener('resize', () => {
      Object.values(charts).forEach((c) => c && c.resize());
      if (map) map.invalidateSize();
      renderCar();  // 引线与标注按舞台实际尺寸定位,需随布局重算
    });

    refresh();
    S.timer = setInterval(refresh, 60 * 1000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
