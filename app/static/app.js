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

  // 电量 ⇄ 度数(kWh)换算:kwh_per_pct 由后端按充电历史校准(充电量 ÷ 表显电量增幅)
  const kwhPerPct = () => {
    const v = S.overview ? Number(S.overview.kwh_per_pct) : NaN;
    return v > 0 ? v : null;
  };
  const kwhAtPct = (pct) => {
    const k = kwhPerPct();
    const p = Number(pct);
    if (k === null || p === null || isNaN(p)) return null;
    return k * p;
  };
  const kwhSuffix = (pct) => {
    const w = kwhAtPct(pct);
    return w === null ? '' : `≈ ${fmtNum(w, 1)} kWh`;
  };

  // 当前生效的电量维度:所选维度的换算数据缺失时自动回退 pct
  const battDim = () => {
    if (S.battMode === 'km' && kmFull() !== null) return 'km';
    if (S.battMode === 'kwh' && kwhPerPct() !== null) return 'kwh';
    return 'pct';
  };
  const BATT_SERIES_NAME = { pct: '电量', kwh: '剩余电量(折算)', km: '剩余里程(折算)' };
  const BATT_UNIT = { pct: '%', kwh: 'kWh', km: 'km' };
  // 电量值按当前维度格式化主单位(如「42%」「35.6 kWh」「353 km」)
  const battVal = (pct) => {
    const dim = battDim();
    if (dim === 'km') { const v = kmAtPct(pct); if (v !== null) return `${fmtNum(v, 0)} km`; }
    if (dim === 'kwh') { const v = kwhAtPct(pct); if (v !== null) return `${fmtNum(v, 1)} kWh`; }
    return `${fmtNum(pct, 0)}%`;
  };
  // 当前维度之外的其他维度提示,如「42% · ≈ 353 km」
  const battAlt = (pct) => {
    const p = Number(pct);
    if (pct === null || pct === undefined || isNaN(p)) return '';
    const dim = battDim();
    const parts = [];
    if (dim !== 'pct') parts.push(`${fmtNum(p, 0)}%`);
    if (dim !== 'kwh') { const w = kwhAtPct(p); if (w !== null) parts.push(`≈ ${fmtNum(w, 1)} kWh`); }
    if (dim !== 'km') { const m = kmAtPct(p); if (m !== null) parts.push(`≈ ${fmtNum(m, 0)} km`); }
    return parts.join(' · ');
  };
  // 电量曲线数据按当前维度换算(折算失败点剔除)
  const battSeriesData = (data) => {
    const dim = battDim();
    if (dim === 'pct') return data;
    const conv = dim === 'km' ? kmAtPct : kwhAtPct;
    return data.map(([t, p]) => [t, conv(p)]).filter((p) => p[1] !== null);
  };
  const battAxisMax = () => {
    const dim = battDim();
    if (dim === 'km') return Math.ceil(kmFull() / 100) * 100;
    if (dim === 'kwh') return Math.ceil(kwhAtPct(100) / 10) * 10;
    return 100;
  };

  // 电量曲线 tooltip 的双单位补充:主单位之外的其他维度
  const dualBatt = {
    '仪表电量': (v) => battAlt(v),
    '电量': (v) => battAlt(v),
    '剩余里程(折算)': (v) => {
      const f = kmFull();
      return !f ? '' : battAlt(v / f * 100);
    },
    '剩余电量(折算)': (v) => {
      const k = kwhPerPct();
      return !k ? '' : battAlt(v / k);
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

  function setBattMode(mode) {
    if (mode !== 'pct' && mode !== 'kwh' && mode !== 'km') return;
    S.battMode = mode;
    localStorage.setItem('ttv-batt-mode', mode);
    document.querySelectorAll('.batt-toggle button').forEach((b) =>
      b.classList.toggle('on', b.dataset.mode === mode));
    // 仅重绘电量相关视图(避免地图 fitBounds 被重置)
    renderHeader(); renderActivity(); renderSentry();
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
  // 顶栏车图:特斯拉设计 studio compositor 渲染图,按车型切换(S/X 国内无 compositor,无图回退)
  const MODEL_IMG = {
    'Model Y L': '/model-y-l.png',
    'Model Y': '/model-y.png',
    'Model 3': '/model-3.png',
  };

  // 车型信息集中判定:显示名 + 是否 Y L(官方尾标徽章)+ 顶栏渲染图
  function carModelInfo(car) {
    const trimKey = car ? `${car.model}|${car.trim_badging || ''}` : '';
    const label = TRIM_LABEL[trimKey] ||
      (car ? (MODEL_LABEL[car.model] || car.model || '') : '');
    return { label, isYL: label === 'Model Y L', img: MODEL_IMG[label] || null };
  }

  function renderHeader() {
    const o = S.overview;
    if (!o) return;
    const car = o.cars.find((c) => c.id === S.carId) || o.cars[0];
    $('#car-name').textContent = car ? car.name : '—';
    const mi = carModelInfo(car);
    // Model Y L 展示官方尾标徽章(PNG 蒙版 + currentColor 随主题变色);其他车型回退为字标文字
    $('#car-model-badge').hidden = !mi.isYL;
    const modelText = $('#car-model-text');
    modelText.hidden = mi.isYL;
    if (!mi.isYL) modelText.textContent = mi.label.toUpperCase();
    // 顶栏车图跟随车型;无对应渲染图的车型隐藏
    const icon = $('.model-icon');
    if (icon) {
      icon.style.display = mi.img ? '' : 'none';
      if (mi.img && !icon.src.endsWith(mi.img)) { icon.src = mi.img; icon.alt = mi.label; }
    }
    const badge = $('#state-badge');
    badge.dataset.state = o.state;
    $('#state-text').textContent = STATE_LABEL[o.state] || o.state;
    $('#sw-version').textContent = o.software_version ? `v${o.software_version}` : '';
    $('#updated-at').textContent = o.latest ? `数据更新 ${fmtTime(Number(o.latest.date_ts))}` : '暂无数据';

    // 电量胶囊:跟随全局 电量%⇄度数kWh⇄里程km 模式;里程直接用最新额定续航
    const lat = o.latest;
    const usable = lat && lat.usable_battery_level != null ? Number(lat.usable_battery_level)
      : (lat && lat.battery_level != null ? Number(lat.battery_level) : null);
    const rated = lat && lat.rated_battery_range_km != null ? Number(lat.rated_battery_range_km) : null;
    const dim = battDim();
    const usableKwh = kwhAtPct(usable);
    $('#batt-text').textContent =
      dim === 'km' && rated !== null
        ? `${fmtNum(rated, 0)} km`
        : dim === 'kwh' && usableKwh !== null
          ? `${fmtNum(usableKwh, 1)} kWh`
          : (usable === null ? '—' : `${fmtNum(usable, 0)}%`);
    const pct = usable === null ? 0 : Math.min(100, Math.max(0, usable));
    $('#batt-fill').setAttribute('width', (19 * pct / 100).toFixed(1));
    $('#batt-pill').dataset.level =
      usable === null ? 'unknown' : pct < 10 ? 'critical' : pct < 20 ? 'low' : 'ok';
  }

  /* ---------- 渲染:折线系列公共构造 ---------- */

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
    // 电量 ⇄ 度数 ⇄ 里程维度切换
    const dim = battDim();
    const battLine = battSeriesData(batt);

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
            ? ` · 增加 ${kmSuffix(Number(c.end_battery_level) - Number(c.start_battery_level))} ${kwhSuffix(Number(c.end_battery_level) - Number(c.start_battery_level))}` : '') +
          (c.cost !== null && c.cost !== undefined ? ` · ¥${fmtNum(c.cost, 2)}` : '') +
          `${c.address_name ? ` · ${c.address_name}` : ''}`,
      },
    ]));
    a.sentry.forEach((p) => stripData.push([
      0, p.s, p.e, catColor('sentry'),
      {
        kind: 'sentry', s: p.s, e: p.e,
        title: '哨兵耗电', body: `${fmtNum(p.dur_min, 0)} 分钟 · 耗电 ${battVal(-p.delta)}${battAlt(-p.delta) ? ' · ' + battAlt(-p.delta) : ''}` +
          (p.rate_pct_h !== null ? ` · 约 ${fmtNum(p.rate_pct_h, 2)} %/h` : ''),
      },
    ]));
    a.idle.forEach((p) => stripData.push([
      0, p.s, p.e, catColor('idle'),
      {
        kind: 'idle', s: p.s, e: p.e,
        title: p.kind === 'climate' ? '驻车耗电(空调)' : '驻车耗电(休眠)',
        body: `${fmtNum(p.dur_min, 0)} 分钟 · 耗电 ${battVal(-p.delta)}${battAlt(-p.delta) ? ' · ' + battAlt(-p.delta) : ''}`,
      },
    ]));

    const stripTip = (m) =>
      `<div style="color:${cssVar('--text-muted')};font-size:11px;margin-bottom:4px">` +
      `${m.title} · ${fmtTime(m.s)} – ${fmtTime(m.e)}</div>` +
      `<div><b>${m.body}</b></div>`;

    charts.activity.setOption(Object.assign({}, chartTheme(), {
      animation: false,
      tooltip: tooltipAxis({ '电量': '%', '剩余电量(折算)': 'kWh', '剩余里程(折算)': 'km' },
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
          max: battAxisMax(),
          axisLabel: { color: cssVar('--text-muted'), fontSize: 11,
            formatter: dim === 'pct' ? '{value}%' : '{value}', inside: true },
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
        Object.assign(lineSeries(BATT_SERIES_NAME[dim], battLine,
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
        (m.cost_per_km_yuan !== null && m.cost_per_km_yuan !== undefined
          ? ` · ¥${fmtNum(m.cost_per_km_yuan, 2)}/km` : '');
    }
    if (ev.kind === 'charge') {
      return `${fmtNum(m.duration_min, 0)} 分` +
        `${m.address_name ? ` · ${m.address_name}` : ''}` +
        (m.rate_yuan_kwh !== null && m.rate_yuan_kwh !== undefined
          ? ` · ¥${fmtNum(m.rate_yuan_kwh, 2)}/kWh` : '');
    }
    const tag = m.kind === 'climate' ? '(空调)' : ev.kind === 'sentry' ? '' : '(休眠)';
    return `${fmtNum(m.dur_min, 0)} 分钟${tag}` +
      (ev.kind === 'sentry' && m.rate_pct_h !== null
        ? ` · 约 ${fmtNum(m.rate_pct_h, 2)} %/h` : '');
  }

  // 事件数值列:电量% / 度数kWh / 里程km / 电费¥(充电为增加量与已付费用,其余为消耗)
  function eventNums(ev) {
    const m = ev.meta;
    const na = { batt: '—', kwh: '—', km: '—', cost: '—', up: false };
    if (ev.kind === 'drive') {
      const battDrop = (m.start_battery_level !== null && m.start_battery_level !== undefined &&
          m.end_battery_level !== null && m.end_battery_level !== undefined)
        ? Number(m.start_battery_level) - Number(m.end_battery_level) : null;
      const delta = (m.start_ideal_range_km !== null && m.end_ideal_range_km !== null)
        ? Number(m.start_ideal_range_km) - Number(m.end_ideal_range_km) : null;
      return {
        batt: battDrop === null ? '—' : battDrop <= 0 ? '0%' : `-${fmtNum(battDrop, 0)}%`,
        kwh: m.energy_kwh === null || m.energy_kwh === undefined ? '—' : `-${fmtNum(m.energy_kwh, 1)}`,
        km: delta === null ? '—' : `-${fmtNum(delta, 1)}`,
        cost: m.cost_yuan === null || m.cost_yuan === undefined ? '—' : `¥${fmtNum(m.cost_yuan, 2)}`,
        up: false,
      };
    }
    if (ev.kind === 'charge') {
      const up = (m.start_battery_level !== null && m.end_battery_level !== null)
        ? Number(m.end_battery_level) - Number(m.start_battery_level) : null;
      const km = kmAtPct(up);
      return {
        batt: up === null ? '—' : `+${fmtNum(up, 0)}%`,
        kwh: m.charge_energy_added === null || m.charge_energy_added === undefined
          ? '—' : `+${fmtNum(m.charge_energy_added, 1)}`,
        km: km === null ? '—' : `+${fmtNum(km, 0)}`,
        cost: m.cost === null || m.cost === undefined ? '—' : `¥${fmtNum(m.cost, 2)}`,
        up: true,
      };
    }
    // 耗电为降幅;采样取整可能出现 ±0.0x 的抖动,钳到 0 避免「-0」
    const drop = Math.max(0, -m.delta);
    const km = kmAtPct(drop);
    return {
      batt: drop <= 0 ? '0%' : `-${fmtNum(drop, 0)}%`,
      kwh: m.energy_kwh === null || m.energy_kwh === undefined ? '—'
        : m.energy_kwh <= 0 ? '0.0' : `-${fmtNum(m.energy_kwh, 1)}`,
      km: km === null ? '—' : km <= 0 ? '0' : `-${fmtNum(km, 0)}`,
      cost: m.cost_yuan === null || m.cost_yuan === undefined ? '—' : `¥${fmtNum(m.cost_yuan, 2)}`,
      up: false,
    };
  }

  function o_kwh() {
    return S.overview ? (S.overview.kwhPerIdealKm || 0) : 0;
  }

  /* 折叠日组右侧的小型环状耗电图:按 行驶/哨兵/驻车空调/驻车耗电 的 kWh 占比分段 */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DRAIN_SEGS = [
    ['drive', '行驶'], ['sentry', '哨兵'], ['climate', '驻车空调'], ['idle', '驻车耗电'],
  ];

  function eventDrainKwh(ev) {
    const m = ev.meta;
    if (ev.kind !== 'drive' && ev.kind !== 'sentry' && ev.kind !== 'idle') return null;
    if (m.energy_kwh !== null && m.energy_kwh !== undefined) return Math.max(0, Number(m.energy_kwh));
    // 缺少能耗字段时按电量%降幅折算(与列表数值列同口径)
    const drop = ev.kind === 'drive'
      ? (m.start_battery_level !== null && m.start_battery_level !== undefined &&
          m.end_battery_level !== null && m.end_battery_level !== undefined)
        ? Number(m.start_battery_level) - Number(m.end_battery_level) : 0
      : -Number(m.delta || 0);
    const kwh = kwhAtPct(Math.max(0, drop));
    return kwh === null ? null : kwh;
  }

  function dayDrainDonut(evs) {
    const drain = { drive: 0, sentry: 0, climate: 0, idle: 0 };
    evs.forEach((ev) => {
      const kwh = eventDrainKwh(ev);
      if (kwh === null || kwh <= 0) return;
      const k = (ev.kind === 'idle' && ev.meta.kind === 'climate') ? 'climate' : ev.kind;
      drain[k] += kwh;
    });
    const total = DRAIN_SEGS.reduce((s, [k]) => s + drain[k], 0);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('class', 'day-donut');
    const mk = (cls) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', '18');
      c.setAttribute('cy', '18');
      c.setAttribute('r', '14');
      c.setAttribute('pathLength', '100');
      c.setAttribute('class', cls);
      return c;
    };
    svg.appendChild(mk('donut-track'));

    const tip = [];
    if (total > 0) {
      let acc = 0;
      DRAIN_SEGS.forEach(([k, label]) => {
        const v = drain[k];
        if (v <= 0) return;
        const len = v / total * 100;
        const seg = mk('donut-seg seg-' + k);
        // pathLength=100 归一化:dashoffset 25 处为环顶,段间留 1% 缝
        const shown = len >= 99 ? 100 : Math.max(len - 1, 0.6);
        seg.setAttribute('stroke-dasharray', `${shown} ${100 - shown}`);
        seg.setAttribute('stroke-dashoffset', String(25 - acc));
        svg.appendChild(seg);
        acc += len;
        tip.push(`${label} ${fmtNum(v, 1)} kWh`);
      });
    }
    const t = document.createElementNS(SVG_NS, 'title');
    t.textContent = tip.length ? tip.join(' · ') : '当日无耗电记录';
    svg.appendChild(t);
    return svg;
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

    // 列头:与 .ev-row 同一套栅格(窄屏隐藏,改由数值格自带小标签)
    const headRow = el('div', 'ev-row ev-head');
    ['时间', '类型', '详情', '电量', '度数', '里程', '电费'].forEach((t, i) =>
      headRow.appendChild(el('span',
        ['ev-time', 'ev-chip', 'ev-desc', 'ev-num', 'ev-num', 'ev-num', 'ev-num'][i], t)));
    box.appendChild(headRow);

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
      head.appendChild(dayDrainDonut(evs));
      head.appendChild(el('span', 'chev', '▾'));
      head.addEventListener('click', () => grp.classList.toggle('open'));
      grp.appendChild(head);

      const body = el('div', 'day-body');
      evs.forEach((ev) => {
        const row = el('div', 'ev-row');
        row.appendChild(el('span', 'ev-time', eventTime(ev.s, ev.e)));
        row.appendChild(el('span', 'ev-chip ' + CAT[ev.kind].cls, CAT[ev.kind].label));
        row.appendChild(el('span', 'ev-desc', eventDesc(ev)));
        const nums = eventNums(ev);
        [['电量', nums.batt], ['度数', nums.kwh], ['里程', nums.km], ['电费', nums.cost]]
          .forEach(([lab, text]) => {
            const cell = el('span', 'ev-num' + (nums.up && lab !== '电费' ? ' up' : ''), text);
            cell.dataset.lab = lab;
            row.appendChild(cell);
          });
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
    const dim = battDim();
    const drainVal = dim === 'km' ? kmAtPct(drain) : dim === 'kwh' ? kwhAtPct(drain) : drain;
    stat('哨兵耗电', drainVal === null ? 0 : drainVal, BATT_UNIT[dim], battAlt(drain));
    const rateVal = hours > 0 ? (drainVal === null ? 0 : drainVal) / hours : 0;
    stat('平均耗电速率', rateVal, BATT_UNIT[dim] + '/h');
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
            `约 ${fmtNum(m.seg.dur_min, 0)} 分钟 · 耗电 ${battVal(-m.seg.delta)}${battAlt(-m.seg.delta) ? ' · ' + battAlt(-m.seg.delta) : ''}` +
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
    const dimDrain = battDim();
    const drainData = [];
    sentry.forEach((p) => {
      for (const [t, l] of a.battery) {
        if (t >= p.s && t <= p.e) drainData.push([t, l]);
      }
    });
    const drainSeries = battSeriesData(drainData);
    charts.sentryDrain.setOption(Object.assign({}, chartTheme(), {
      animation: false,
      tooltip: tooltipAxis({ '电量': '%', '剩余电量(折算)': 'kWh', '剩余里程(折算)': 'km' },
        (v) => fmtTime(v, true), dualBatt),
      grid: trendGrid(24),
      xAxis: Object.assign(timeAxis(S.days), { min: domain.min, max: domain.max }),
      yAxis: Object.assign(axisCommon(), { type: 'value', scale: true,
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11,
          formatter: dimDrain === 'pct' ? '{value}%' : '{value}' } }),
      series: [Object.assign(lineSeries(BATT_SERIES_NAME[dimDrain], drainSeries,
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

  // 玻璃顶能量环:pathLength=100,各段用 dasharray/offset 沿环分布(顶点=起点,顺时针)

  // 分段点选:能量环 ⇄ 图例详情 联动高亮(再点一次或点空白处取消)
  let carSel = null;
  function setCarSel(k) {
    carSel = k || null;
    document.querySelectorAll('.car-svg .carring').forEach((r) => {
      r.classList.toggle('dim', !!carSel && r.id !== `carring-${carSel}`);
    });
    document.querySelectorAll('.cl-item[data-k]').forEach((d) =>
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

    /* --- 能量占比环:围绕玻璃顶一圈(自顶点顺时针),pathLength=100 归一化 --- */
    const RING_KEYS = ['uncharged', 'idle', 'climate', 'sentry', 'drive', 'remaining'];
    const GAP = 0.8;  // 段间缝隙(占环长 %)
    const setRing = (k, start, len) => {
      const p = $(`#carring-${k}`);
      if (!p) return;
      if (len <= GAP) {
        p.setAttribute('stroke-dasharray', '0 100');
        return;
      }
      p.setAttribute('stroke-dasharray',
        `${(len - GAP).toFixed(2)} ${(100 - len + GAP).toFixed(2)}`);
      p.setAttribute('stroke-dashoffset', (-(start + GAP / 2)).toFixed(2));
    };
    if (!cyc) {
      RING_KEYS.forEach((k) => {
        const p = $(`#carring-${k}`);
        if (p) p.setAttribute('stroke-dasharray', '0 100');
      });
    } else {
      // 顶点起第一段斜纹 = 本次未充(100% − 充至电量);充入区各段按估算值归一化填满
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
      inner.forEach(([k, v, raw]) => {
        const frac = raw ? v : v * scale;
        setRing(k, 100 - cum, frac);
        cum -= frac;
      });
    }

    /* --- 左列:里程统计(额定续航 / 本月里程 / 本周里程,仅展示) --- */
    const lat = o.latest || null;
    const t = o.totals || {};
    const rated = lat && lat.rated_battery_range_km != null ? Number(lat.rated_battery_range_km) : null;
    const odo = lat && lat.odometer != null ? Number(lat.odometer) : null;
    const usable = lat && lat.usable_battery_level != null ? Number(lat.usable_battery_level) : null;
    const fullKm = kmFull();
    const statCol = $('#car-legend-l');
    statCol.textContent = '';
    [
      { name: '额定续航', v: rated, sub: fullKm === null ? '' : `满电约 ${fmtNum(fullKm, 0)} km` },
      { name: '本月里程', v: t.month_km != null ? Number(t.month_km) : null, sub: '' },
      { name: '本周里程', v: t.week_km != null ? Number(t.week_km) : null, sub: '' },
    ].forEach((s) => {
      const d = el('div', 'cl-item cl-stat');
      const tx = el('div');
      tx.appendChild(el('b', '', s.name));
      tx.appendChild(el('span', 'cl-val', s.v === null ? '—' : `${fmtNum(s.v, 0)} km`));
      if (s.sub) tx.appendChild(el('span', 'cl-sub', s.sub));
      d.appendChild(tx);
      statCol.appendChild(d);
    });

    /* --- 电池健康(小模块,无曲线):基准=历史最高满电容量估算,当前=最新一次充电估算 --- */
    const bh = S.health;
    const bhItem = el('div', 'cl-item cl-stat');
    const bhTx = el('div');
    bhTx.appendChild(el('b', '', '电池健康'));
    const bhHas = bh && bh.health_pct !== null && bh.health_pct !== undefined;
    const bhVal = el('span', 'cl-val', bhHas ? `${fmtNum(bh.health_pct, 1)} %` : '—');
    if (bhHas) {
      bhVal.style.color =
        bh.health_pct >= 97 ? '#3fae72' : bh.health_pct >= 90 ? '#fab219' : '#d03b3b';
    }
    bhTx.appendChild(bhVal);
    bhTx.appendChild(el('span', 'cl-sub', bhHas
      ? `估算 ${fmtNum(bh.current_kwh, 1)} / 基准 ${fmtNum(bh.nominal_kwh, 1)} kWh`
      : '暂无充电数据'));
    if (bhHas) {
      bhTx.appendChild(el('span', 'cl-sub',
        `最近充电 ${fmtTime(bh.last_ts)} · ${bh.samples} 次样本`));
    }
    bhItem.appendChild(bhTx);
    statCol.appendChild(bhItem);

    /* --- 车身读数:车头总里程 / 前风挡电量横向填充 / 玻璃中央徽章+车内温度 / 后风挡车外温度 --- */
    $('#car-odo').textContent = odo === null ? '—' : `${fmtNum(odo, 0)} km`;
    const wr = $('#carfill-batt');
    if (wr) {
      const WW = 146;  // 前风挡宽(x 97..243),横向填充
      wr.setAttribute('width',
        (usable === null ? 0 : Math.max(0, Math.min(100, usable)) / 100 * WW).toFixed(1));
    }
    $('#car-batt-val').textContent = usable === null ? '—' : `${fmtNum(usable, 0)}%`;
    // 车型徽章:Model Y L 显示官方尾标图,其他车型回退字标文字
    const car0 = o.cars.find((c) => c.id === S.carId) || o.cars[0];
    const cmi = carModelInfo(car0);
    const badgeImg = $('#car-badge');
    if (badgeImg) badgeImg.style.display = cmi.isYL ? '' : 'none';
    const cm = $('#car-center-model');
    if (cm) {
      cm.style.display = cmi.isYL ? 'none' : '';
      if (!cmi.isYL) cm.textContent = cmi.label.toUpperCase();
    }
    const inT = lat && lat.inside_temp != null ? Number(lat.inside_temp) : null;
    const outT = lat && lat.outside_temp != null ? Number(lat.outside_temp) : null;
    $('#car-center-temp').textContent = inT === null ? '—' : `车内 ${fmtNum(inT, 1)}°`;
    $('#car-temp-val').textContent = outT === null ? '—' : `${fmtNum(outT, 1)}°`;

    // 车内温度曲线:直接画在玻璃上(温度读数下方,x 112..228 / y 306..336)
    const spark = $('#car-temp-spark');
    const sparkArea = $('#car-temp-spark-area');
    const idata = ((o.temp && o.temp.inside) || []).map((p) => [Number(p[0]), Number(p[1])]);
    if (spark && sparkArea) {
      if (idata.length < 2) {
        spark.setAttribute('points', '');
        sparkArea.setAttribute('d', '');
      } else {
        const X0 = 112, X1 = 228, Y0 = 306, Y1 = 336;
        let lo = Infinity, hi = -Infinity;
        idata.forEach((p) => { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); });
        if (hi - lo < 2) { lo -= 1; hi += 1; }
        const pad = (hi - lo) * 0.15; lo -= pad; hi += pad;
        const t0 = idata[0][0], t1 = idata[idata.length - 1][0];
        const pts = idata.map((p) => {
          const x = X0 + (t1 > t0 ? (p[0] - t0) / (t1 - t0) : 0) * (X1 - X0);
          const y = Y1 - (p[1] - lo) / (hi - lo) * (Y1 - Y0);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        });
        spark.setAttribute('points', pts.join(' '));
        sparkArea.setAttribute('d',
          `M${X0},${Y1} L${pts.join(' L')} L${X1},${Y1} Z`);
      }
    }

    // 车辆顶部:本周期平均能耗细长条(官方能耗=额定折算系数,作标点)
    const effG = $('#car-eff');
    if (effG) {
      const dKwh = cyc && cyc.drive_kwh != null ? Number(cyc.drive_kwh) : 0;
      const dKm = cyc && cyc.drive_km != null ? Number(cyc.drive_km) : 0;
      const official = o.kwh_per_ideal_km ? Number(o.kwh_per_ideal_km) * 1000 : null;
      if (dKm >= 1 && official) {
        const eff = dKwh * 1000 / dKm;
        const LO = 100, HI = 200;   // 刻度 100..200 Wh/km
        const map = (v) => Math.max(0, Math.min(1, (v - LO) / (HI - LO))) * 100;
        $('#car-eff-dot').style.left = map(eff).toFixed(1) + '%';
        $('#car-eff-official').style.left = `calc(${map(official).toFixed(1)}% - 1px)`;
        // 低于官方绿 / 高 10% 内黄 / 再高红
        const rel = eff / official;
        const dotColor = rel <= 1 ? '#3fae72' : rel <= 1.1 ? '#fab219' : '#d03b3b';
        $('#car-eff-dot').style.background = dotColor;
        const fill = $('#car-eff-fill');
        fill.style.width = map(eff).toFixed(1) + '%';
        fill.style.background = dotColor;
        const offVal = $('#car-eff-official-val');
        offVal.style.left = map(official).toFixed(1) + '%';
        offVal.textContent = `官方 ${fmtNum(official, 0)}`;
        $('#car-eff-val').textContent = `${fmtNum(eff, 0)} Wh/km`;
        effG.hidden = false;
      } else {
        effG.hidden = true;
      }
    }

    /* --- 右列:全部电耗分段(未充/驻车耗电/驻车空调/哨兵/行驶/剩余,与车身分带点选联动) --- */
    const cap = cyc && cyc.cap_kwh ? Number(cyc.cap_kwh) : 84;
    const itemsR = [
      { k: 'uncharged', name: '本次未充', pct: cyc ? Number(cyc.uncharged_pct) : null, hatch: true },
      { k: 'idle', name: '驻车耗电', pct: cyc ? Number(cyc.idle_pct) : null, color: 'var(--cat-idle)' },
      { k: 'climate', name: '驻车空调', pct: cyc ? Number(cyc.climate_pct) : null, color: 'var(--cat-climate)' },
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
    fillCol('#car-legend-r', itemsR);


    /* --- 四轮胎压:当前值 + 迷你平滑填充曲线(只看最近 24 小时);
           统一按与标准胎压 2.9 bar 的偏差着色 --- */
    const TPMS_STD = 2.9;
    const tpmsColor = (v) => {
      const dev = Math.abs(v - TPMS_STD);
      return dev <= 0.15 ? '#3fae72' : dev <= 0.3 ? '#fab219' : '#d03b3b';
    };
    const w = (o.tpms24 && o.tpms24.wheels) || {};
    const wheels = [['fl', 'wfl'], ['fr', 'wfr'], ['rl', 'wrl'], ['rr', 'wrr']];
    wheels.forEach(([key, cid]) => {
      const data = (w[key] || []).map((p) => [Number(p[0]), Number(p[1])]);
      const lastV = data.length ? data[data.length - 1][1] : null;
      const valEl = $(`#tpms-val-${key}`);
      if (valEl) {
        valEl.textContent = lastV === null ? '—' : fmtNum(lastV, 1);
        valEl.style.color = lastV === null ? '' : tpmsColor(lastV);
      }
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
      const color = lastV === null ? cssVar('--baseline') : tpmsColor(lastV);
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

  /* ---------- 渲染:充电详情(卡片式,纵向布局,适配手机) ---------- */

  function fmtDur(min) {
    const m = Number(min);
    if (!m || m <= 0) return '—';
    if (m < 60) return `${fmtNum(m, 0)} 分`;
    return `${Math.floor(m / 60)} 小时 ${fmtNum(m % 60, 0)} 分`;
  }

  // 保存后定向刷新:sessions 必刷;费用变动还要同步活动事件的金额(不重置地图视野)
  async function csRefresh(withCosts) {
    const reqs = [api(`charging/sessions?days=${S.days}`)];
    if (withCosts) reqs.push(api(`activity?days=${S.days}`));
    const [sessions, act] = await Promise.all(reqs);
    S.sessions = sessions;
    if (withCosts) {
      S.overview.activity = act;
    }
    renderSessions();
    renderChargers();
    renderCsBatt();
    if (withCosts) { renderEvents(); renderActivity(); }
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
      // 品牌与名称/地点一起存档(按地点键,同地点自动带出)
      const brandInp = el('input', 'cs-brand-input');
      brandInp.type = 'text';
      brandInp.placeholder = '品牌';
      brandInp.maxLength = 40;
      brandInp.value = c.charger_brand || '';
      brandInp.dataset.orig = c.charger_brand || '';
      const saveCharger = () => {
        const name = nameInp.value.trim();
        const loc = locInp.value.trim();
        const brand = brandInp.value.trim();
        if (name === nameInp.dataset.orig && loc === locInp.dataset.orig
            && brand === brandInp.dataset.orig) return;
        nameInp.disabled = locInp.disabled = brandInp.disabled = true;
        csSave('/api/charging/charger',
          { charge_id: c.id, name, location: loc, brand },
          [nameInp, locInp, brandInp], false);
      };
      nameInp.addEventListener('change', saveCharger);
      locInp.addEventListener('change', saveCharger);
      brandInp.addEventListener('change', saveCharger);
      chg.appendChild(nameInp);
      chg.appendChild(brandInp);
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

  /* ---------- 渲染:电池电量估算条形图(充电详情卡底部,并入同卡) ----------
     每次充电:充后总电量 = 充至电量% × 估算满电;估算满电 = 充电量 ÷ 增幅
     (与「电池健康」同口径:增幅 <10% 或估算超出 30–150 kWh 的样本不参与) */

  function renderCsBatt() {
    const box = $('#chart-cs-batt');
    if (!box || !S.overview) return;
    // 数据源同「充电记录」上图(charging/summary,最近 12 次,不随时间范围裁剪)
    const pts = [];
    (S.overview.chargingSessions || []).slice().reverse().forEach((c) => {  // 旧的在前
      const s = c.start_battery_level, e = c.end_battery_level;
      if (s == null || e == null || c.charge_energy_added == null || !c.end_date_ts) return;
      const d = e - s;
      if (d < 10) return;
      const full = Number(c.charge_energy_added) / d * 100;
      if (full < 30 || full > 150) return;
      pts.push({ ts: c.end_date_ts, level: e, full: Math.round(full * 10) / 10,
                 after: Math.round(e * full) / 100 });
    });
    const emptyEl = $('#cs-batt-empty');
    if (!pts.length) {
      box.style.display = 'none';
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    box.style.display = '';
    if (emptyEl) emptyEl.hidden = true;
    if (!charts.csBatt) charts.csBatt = echarts.init(box);
    charts.csBatt.setOption(Object.assign({}, chartTheme(), {
      tooltip: {
        trigger: 'axis',
        backgroundColor: cssVar('--surface-1'),
        borderColor: cssVar('--border'), borderWidth: 1, padding: [6, 10],
        textStyle: { color: cssVar('--text-primary'), fontSize: 12 },
        extraCssText: 'box-shadow: 0 4px 16px rgba(0,0,0,.18);border-radius:8px;',
        axisPointer: { type: 'shadow', shadowStyle: { color: cssVar('--tile-track') } },
        formatter(params) {
          const p = pts[params[0].dataIndex];
          // 堆叠柱第二段是「差额」,tooltip 要显示换算出的完整估算值
          return `<div style="color:${cssVar('--text-muted')};font-size:10px">` +
                 `${fmtTime(p.ts)} · 充至 ${fmtNum(p.level, 0)}%</div>` +
                 `${params[0].marker} 充后总电量 <b>${fmtNum(p.after, 1)} kWh</b><br>` +
                 `${params[1].marker} 估算满电 <b>${fmtNum(p.full, 1)} kWh</b>`;
        },
      },
      legend: {
        top: 0, right: 0,
        textStyle: { color: cssVar('--text-muted'), fontSize: 11 },
        itemWidth: 12, itemHeight: 8,
        data: [
          { name: '充后总电量' },
          // 图例图标同步虚线框样式(系列本身是透明填充)
          { name: '估算满电', itemStyle: { color: 'transparent',
              borderColor: cssVar('--series-3'), borderWidth: 1.5, borderType: 'dashed' } },
        ],
      },
      grid: { left: 8, right: 12, top: 30, bottom: 4, containLabel: true },
      // 与上方「充电记录」一致:按充电日期类目轴
      xAxis: Object.assign(axisCommon(), { type: 'category',
        data: pts.map((p) => fmtTime(Number(p.ts)).slice(0, 5)),
        axisLabel: { color: cssVar('--text-muted'), fontSize: 11 } }),
      yAxis: Object.assign({ type: 'value', name: 'kWh', scale: true,
        nameTextStyle: { color: cssVar('--text-muted'), fontSize: 10 } }, axisCommon()),
      series: [
        // 实心柱:充后总电量;上方虚线框柱:到估算满电的差额(柱顶即估算满电)
        { name: '充后总电量', type: 'bar', stack: 'batt', barMaxWidth: 22,
          data: pts.map((p) => p.after),
          itemStyle: { color: cssVar('--series-1'), borderRadius: [0, 0, 0, 0] } },
        { name: '估算满电', type: 'bar', stack: 'batt', barMaxWidth: 22,
          data: pts.map((p) => Math.round((p.full - p.after) * 10) / 10),
          itemStyle: {
            color: 'transparent',
            borderColor: cssVar('--series-3'),
            borderWidth: 1.5,
            borderType: 'dashed',
            borderRadius: [4, 4, 0, 0],
          },
          emphasis: { itemStyle: { color: cssVar('--series-3') + '22' } } },
      ],
    }), { notMerge: true });
  }

  /* ---------- 渲染:停车费(手动记录;默认当天,可选覆盖接下来 N 天) ---------- */

  function renderParking() {
    const box = $('#pk-list');
    if (!box || !S.parking) return;
    box.textContent = '';

    // 头部统计:本月合计 / 累计
    const stats = $('#pk-stats');
    stats.textContent = '';
    const stat = (label, value) => {
      const t = el('span', 'mini-stat');
      t.appendChild(el('span', '', label + ' '));
      t.appendChild(el('b', '', value));
      stats.appendChild(t);
    };
    stat('本月', `¥${fmtNum(S.parking.month_total || 0, 2)}`);
    stat('累计', `¥${fmtNum(S.parking.total || 0, 2)}`);

    const fees = S.parking.fees || [];
    if (!fees.length) {
      box.appendChild(el('div', 'empty', '暂无停车费记录'));
      return;
    }
    fees.forEach((f) => {
      const row = el('div', 'pk-row');
      row.appendChild(el('span', 'pk-date-t', f.date));
      if (f.days > 1) row.appendChild(el('span', 'pk-days-t', `覆盖 ${f.days} 天`));
      row.appendChild(el('span', 'pk-note-t', f.note || ''));
      row.appendChild(el('b', 'pk-cost-t', `¥${fmtNum(f.cost, 2)}`));
      const del = el('button', 'pk-del', '✕');
      del.title = '删除这条记录';
      del.addEventListener('click', async () => {
        if (!confirm(`删除 ${f.date} 的 ¥${fmtNum(f.cost, 2)} 停车费记录?`)) return;
        try {
          await fetchJSON(`/api/parking/fees/${encodeURIComponent(f.key)}`,
            { method: 'DELETE' });
          S.parking = await api('parking/fees');
          renderParking();
        } catch (err) { console.error(err); }
      });
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  function initParking() {
    const dateInp = $('#pk-date');
    if (!dateInp) return;
    // 默认当天(本地时区)
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    dateInp.value = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    $('#pk-add').addEventListener('click', async () => {
      const cost = parseFloat($('#pk-cost').value);
      if (isNaN(cost) || cost <= 0) { $('#pk-cost').focus(); return; }
      const body = {
        date: dateInp.value,
        cost,
        days: parseInt($('#pk-days').value, 10) || 1,
        note: $('#pk-note').value.trim(),
      };
      if (!body.date) { dateInp.focus(); return; }
      const btn = $('#pk-add');
      btn.disabled = true;
      try {
        await fetchJSON('/api/parking/fees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        $('#pk-cost').value = '';
        $('#pk-note').value = '';
        $('#pk-days').value = '1';
        S.parking = await api('parking/fees');
        renderParking();
      } catch (err) {
        console.error(err);
        btn.title = '保存失败,请重试';
      } finally {
        btn.disabled = false;
      }
    });
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
    if (res.status === 401) {  // 会话失效:回登录页,登录后原路返回
      location.href = '/login?next=' + encodeURIComponent(location.pathname);
      throw new Error('unauthorized');
    }
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
      const [daily, chg, routes, act, eff, tpms, sys, health, sessions, cyc, temp, tpms24, pk] = await Promise.all([
        api(`drives/daily?days=${S.days}`),
        api('charging/summary?limit=12'),
        api(`routes?days=${S.days}`),
        api(`activity?days=${S.days}`),
        api(`efficiency/trend?days=${S.days}`),
        api(`tpms/trend?days=${S.days}`),
        api('system'),
        api('battery/health'),
        api(`charging/sessions?days=${S.days}`),
        api('energy/cycles?limit=10'),
        api(`temp/trend?days=${S.days}`),
        api('tpms/trend?days=1'),
        api('parking/fees'),
      ]);
      S.overview = {
        ...o,
        kwhPerIdealKm: o.kwh_per_ideal_km,
        dailyRows: daily.days_rows,
        chargingSessions: chg.sessions,
        routes,
        activity: act,
        efficiency: eff,
        tpms,
        tpms24,
        temp,
      };
      S.health = health;
      S.sessions = sessions;
      S.cycles = cyc;
      S.parking = pk;
      $('#state-badge').dataset.state = 'unknown';
      renderSys(sys);
      renderHeader();
      renderCtlState();
      renderCar();
      renderSessions();
      renderChargers();
      renderCsBatt();
      renderParking();
      renderDaily();
      renderCharging();
      renderRoutes();
      renderRoutesList();
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
    renderHeader();
    renderDaily(); renderCharging();
    renderRoutes(); renderRoutesList();
    renderActivity(); renderEvents(); renderSentry();
    renderEfficiency(); renderTpms(); renderCar(); renderSessions(); renderChargers(); renderCsBatt(); renderTemp(); renderParking();
  }

  /* ---------- 功能分页(底部液态玻璃 Tab 栏) ---------- */

  const PAGE_IDS = ['overview', 'charging', 'drives', 'activity', 'vehicle', 'control'];
  let mapShown = false;  // 行程页首次显示时需 invalidateSize + 重新 fitBounds

  // 选中气泡跟随当前 Tab(首次定位不开动画,避免从 0 宽度弹入)
  function placeTabBubble() {
    const bar = $('#tabbar');
    const btn = bar && bar.querySelector('.tab.on');
    const bubble = $('#tab-bubble');
    if (!btn || !bubble) return;
    bubble.style.left = btn.offsetLeft + 'px';
    bubble.style.width = btn.offsetWidth + 'px';
    bubble.classList.remove('no-anim');
  }

  function switchTab(name, save) {
    if (!PAGE_IDS.includes(name)) name = 'overview';
    if (save !== false) localStorage.setItem('ttv-tab', name);
    document.querySelectorAll('.page').forEach((p) =>
      p.classList.toggle('active', p.id === 'page-' + name));
    document.querySelectorAll('.tabbar .tab').forEach((t) => {
      const on = t.dataset.page === name;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    placeTabBubble();
    // 隐藏页里的 ECharts / Leaflet 尺寸为 0,显示后要重算
    requestAnimationFrame(() => {
      const sec = document.getElementById('page-' + name);
      if (sec) Object.values(charts).forEach((c) => {
        if (c && sec.contains(c.getDom())) c.resize();
      });
      if (name === 'drives' && map) {
        map.invalidateSize();
        if (!mapShown) {  // 首次显示:此前 fitBounds 基于 0 尺寸,按全部轨迹重算
          mapShown = true;
          let b = null;
          Object.values(routesLayers).forEach((l) => {
            b = b ? b.extend(l.getBounds()) : l.getBounds();
          });
          if (b) map.fitBounds(b, { padding: [30, 30] });
        }
      }
      if (name === 'overview') renderCar();  // 俯视图标注随舞台尺寸定位,重算一次
    });
  }

  /* ---------- 车辆控制 ---------- */

  let ctlTemp = 21.5;  // 空调温度步进当前值(°C)

  // 指令结果 toast:浮在 Tab 栏上方的玻璃胶囊,3 秒自动消失
  let ctlToastTimer = null;
  function ctlToast(text, ok) {
    let t = $('#ctl-toast');
    if (!t) {
      t = el('div', 'ctl-toast');
      t.id = 'ctl-toast';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.toggle('err', !ok);
    t.classList.add('show');
    clearTimeout(ctlToastTimer);
    ctlToastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // 查询控制后端配置状态:未配置显示引导,已配置显示控制面板
  async function loadControlStatus() {
    try {
      const st = await api('control/status');
      const configured = !!st.configured;
      $('#ctl-setup').hidden = configured;
      $('#ctl-main').hidden = !configured;
      $('#ctl-backend').textContent = configured
        ? `指令后端:${st.backend}${st.vin_tail ? ` · VIN …${st.vin_tail}` : ''}`
        : '';
    } catch (e) { /* 401 会跳登录页;其他错误保留引导态 */ }
  }

  // 状态条:复用 overview 数据(车辆状态 / 电量 / 车内温度 / 空调),休眠时给唤醒提示
  function renderCtlState() {
    const box = $('#ctl-state');
    const o = S.overview;
    if (!box || !o) return;
    box.textContent = '';
    const lat = o.latest || {};
    const badge = el('span', 'badge');
    badge.dataset.state = o.state || 'unknown';
    badge.append(el('span', 'dot'), el('span', '', STATE_LABEL[o.state] || o.state || '—'));
    box.appendChild(badge);
    const usable = lat.usable_battery_level != null ? Number(lat.usable_battery_level) : null;
    if (usable !== null) {
      const s = el('span');
      s.append('电量 ', el('b', '', battVal(usable)));
      box.appendChild(s);
    }
    if (lat.inside_temp != null) {
      const s = el('span');
      s.append('车内 ', el('b', '', `${Number(lat.inside_temp).toFixed(1)}°C`));
      box.appendChild(s);
    }
    if (lat.is_climate_on != null) {
      const s = el('span');
      s.append('空调 ', el('b', '', lat.is_climate_on ? '开启' : '关闭'));
      box.appendChild(s);
    }
    if (o.state === 'asleep' || o.state === 'offline') {
      box.appendChild(el('span', 'ctl-sleep-hint',
        '车辆休眠中:首条指令会先唤醒车辆,可能需要 10–30 秒'));
    }
  }

  async function sendCmd(cmd, args, btn) {
    if (btn.dataset.confirm && !confirm(btn.dataset.confirm)) return;
    const label = btn.textContent.trim();
    btn.disabled = true;
    btn.classList.add('busy');
    try {
      const res = await fetch('/api/control/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd, args }),
      });
      if (res.status === 401) { location.href = '/login?next=/'; return; }
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) ctlToast(`✓ ${label}:已执行`, true);
      else ctlToast(`${label}:${data.reason || data.detail || `HTTP ${res.status}`}`, false);
    } catch (e) {
      ctlToast(`${label}:网络错误`, false);
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  }

  function initControl() {
    // 指令按钮统一走事件委托;参数来自 data-args(静态 JSON)或 data-args-src(温度/滑杆当前值)
    $('#page-control').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (!b) return;
      let args = {};
      if (b.dataset.args) {
        try { args = JSON.parse(b.dataset.args); } catch (_) { /* 静态 JSON,忽略 */ }
      }
      if (b.dataset.argsSrc === 'temp') args = { driver_temp: ctlTemp };
      if (b.dataset.argsSrc === 'limit') args = { percent: Number($('#ctl-limit').value) };
      sendCmd(b.dataset.cmd, args, b);
    });
    $('#ctl-temp-minus').addEventListener('click', () => {
      ctlTemp = Math.max(15, Math.round((ctlTemp - 0.5) * 2) / 2);
      $('#ctl-temp-val').textContent = `${ctlTemp.toFixed(1)}°C`;
    });
    $('#ctl-temp-plus').addEventListener('click', () => {
      ctlTemp = Math.min(30, Math.round((ctlTemp + 0.5) * 2) / 2);
      $('#ctl-temp-val').textContent = `${ctlTemp.toFixed(1)}°C`;
    });
    $('#ctl-limit').addEventListener('input', (e) => {
      $('#ctl-limit-val').textContent = `${e.target.value}%`;
    });
    loadControlStatus();
  }

  /* ---------- 初始化 ---------- */

  function init() {
    applyTheme();
    charts.daily = echarts.init($('#chart-daily'));
    charts.charging = echarts.init($('#chart-charging'));
    charts.activity = echarts.init($('#chart-activity'));
    charts.sentryLanes = echarts.init($('#chart-sentry-lanes'));
    charts.sentryDrain = echarts.init($('#chart-sentry-drain'));
    charts.efficiency = echarts.init($('#chart-efficiency'));
    charts.tpms = echarts.init($('#chart-tpms'));
    charts.temp = echarts.init($('#chart-temp'));
    charts.wfl = echarts.init($('#chart-wfl'));
    charts.wfr = echarts.init($('#chart-wfr'));
    charts.wrl = echarts.init($('#chart-wrl'));
    charts.wrr = echarts.init($('#chart-wrr'));

    // 功能分页:底部 Tab 栏点击切换,记忆上次所在页
    $('#tabbar').addEventListener('click', (e) => {
      const b = e.target.closest('.tab');
      if (b) switchTab(b.dataset.page);
    });
    switchTab(localStorage.getItem('ttv-tab') || 'overview', false);

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

    // 俯视图能量环 ⇄ 图例:点击互相定位高亮
    $('.car-svg').addEventListener('click', (e) => {
      const r = e.target.closest('.carring');
      if (!r) { setCarSel(null); return; }
      const k = r.id.replace('carring-', '');
      setCarSel(carSel === k ? null : k);
    });
    document.querySelectorAll('.car-legend').forEach((box) =>
      box.addEventListener('click', (e) => {
        const d = e.target.closest('.cl-item');
        if (!d || !d.dataset.k) return;  // 里程统计项不参与点选
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

    // 点击标题刷新;点击电量胶囊循环切换 电量% → 度数kWh → 续航km
    $('#title-refresh').addEventListener('click', refresh);
    const pill = $('#batt-pill');
    const PILL_ORDER = ['pct', 'kwh', 'km'];
    const togglePill = () =>
      setBattMode(PILL_ORDER[(PILL_ORDER.indexOf(S.battMode) + 1) % PILL_ORDER.length]);
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

    // 充电详情:整卡可折叠,默认折叠,展开状态跨会话记忆
    const csCard = $('#cs-card');
    if (localStorage.getItem('ttv-cs-open') === '1') csCard.classList.add('open');
    const csHead = $('#cs-head');
    const csToggle = () => {
      const open = csCard.classList.toggle('open');
      localStorage.setItem('ttv-cs-open', open ? '1' : '0');
    };
    csHead.addEventListener('click', csToggle);
    csHead.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); csToggle(); }
    });

    initParking();
    initControl();

    // 停车费:整卡可折叠,默认收起,展开状态跨会话记忆(与充电详情同款)
    const pkCard = $('#pk-card');
    if (localStorage.getItem('ttv-pk-open') === '1') pkCard.classList.add('open');
    const pkHead = $('#pk-head');
    const pkToggle = () => {
      const open = pkCard.classList.toggle('open');
      localStorage.setItem('ttv-pk-open', open ? '1' : '0');
    };
    pkHead.addEventListener('click', pkToggle);
    pkHead.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pkToggle(); }
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
      placeTabBubble();  // 气泡宽度随 Tab 布局变化
    });

    refresh();
    S.timer = setInterval(refresh, 60 * 1000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
