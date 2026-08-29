/* TeslaMate 遥测面板前端逻辑 */
(function () {
  'use strict';

  const S = {
    carId: null,
    days: 7,
    theme: localStorage.getItem('ttv-theme') || 'dark',
    battMode: localStorage.getItem('ttv-batt-mode') || 'pct',
    overview: null,
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
    renderKpis(); renderTrends(); renderActivity(); renderSentry();
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

  function renderHeader() {
    const o = S.overview;
    if (!o) return;
    const car = o.cars.find((c) => c.id === S.carId) || o.cars[0];
    $('#car-name').textContent = car ? car.name : '—';
    $('#car-model').textContent = car ? [car.model, car.trim_badging].filter(Boolean).join(' ') : '';
    const badge = $('#state-badge');
    badge.dataset.state = o.state;
    $('#state-text').textContent = STATE_LABEL[o.state] || o.state;
    $('#sw-version').textContent = o.software_version ? `v${o.software_version}` : '';
    $('#updated-at').textContent = o.latest ? `数据更新 ${fmtTime(Number(o.latest.date_ts))}` : '暂无数据';
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
    mapTiles.dark = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>', maxZoom: 19 });
    mapTiles.light = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>', maxZoom: 19 });
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
      const [trend, daily, recent, chg, routes, act, eff, tpms, costs] = await Promise.all([
        api(`trend?days=${S.days}`),
        api(`drives/daily?days=${S.days}`),
        api('drives/recent?limit=10'),
        api('charging/summary?limit=12'),
        api(`routes?days=${S.days}`),
        api(`activity?days=${S.days}`),
        api(`efficiency/trend?days=${S.days}`),
        api(`tpms/trend?days=${S.days}`),
        api('charging/costs?days=90'),
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
      };
      $('#state-badge').dataset.state = 'unknown';
      renderHeader();
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
    renderEfficiency(); renderTpms();
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

    $('#range-seg').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      document.querySelectorAll('#range-seg button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      S.days = Number(btn.dataset.days);
      refresh();
    });

    $('#refresh-btn').addEventListener('click', refresh);
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
    });

    refresh();
    S.timer = setInterval(refresh, 60 * 1000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
