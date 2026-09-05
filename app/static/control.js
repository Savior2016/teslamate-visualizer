(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  let model={configured:false,role:'viewer',states:{},nap:{}}, busy=false, loading=false, vehicle={}, strobeSeconds=30;
  const dialog=$('ctl-dialog');
  const tri=(value,on='开启',off='关闭')=>value==null?'未知':value?on:off;
  const num=value=>value==null?'—':Number(value).toFixed(1)+'°C';
  const phases={starting:'正在开启',active:'午休中',stopping:'正在结束',retrying:'结束待确认',completed:'已结束',failed:'未开启'};
  const active=()=>['starting','active','stopping','retrying'].includes(model.nap?.phase);
  const canWrite=()=>model.configured&&model.role==='admin';
  const SENDING='正在发送指令；若车辆休眠将先自动唤醒，可能需要 10–40 秒…';
  function message(text,error=false) {
    ['ctl-operation-message','ctl-dialog-message'].forEach(id=>{$(id).textContent=text;$(id).classList.toggle('error',error);});
  }
  async function api(path,body) {
    const response=await fetch('/api/control/'+path,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(response.status===401){location.href='/login?next=/';throw Error('请先登录');}
    const data=await response.json();
    if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:'操作失败，请检查填写内容');
    return data;
  }
  function napText() {
    const n=model.nap||{};
    if(n.phase==='active') {
      const seconds=Math.max(0,Math.ceil(n.ends_at-Date.now()/1000));
      return seconds ? `剩余 ${Math.floor(seconds/60)} 分 ${seconds%60} 秒` : '时间已到，正在确认关闭';
    }
    return phases[n.phase]||'定时露营';
  }
  function renderNap(){
    $('ctl-module-nap').textContent=napText();
    if($('ctl-nap-status'))$('ctl-nap-status').textContent=napText()+(model.nap?.error?' · '+model.nap.error:'');
  }
  /* 车身部位:开/关只靠视觉效果(发光描边+图标变色,车锁换图标),不再拼状态文字 */
  const zones={lock:['locked','已锁','未锁'],sentry:['sentry','哨兵已开启','哨兵已关闭'],windows:['windows_open','车窗已通风','车窗已关闭'],chargeport:['charge_port','充电口已打开','充电口已关闭'],frunk:['frunk_open','前备箱已打开','前备箱已关闭'],trunk:['trunk_open','后备箱已打开','后备箱已关闭'],climate:['climate_on','空调已开启','空调已关闭']};
  const names={lock:'车锁',sentry:'哨兵',windows:'车窗',chargeport:'充电口',frunk:'前备箱',trunk:'后备箱',climate:'空调'};
  function renderZones(){
    const s=model.states||{};
    Object.entries(zones).forEach(([zone,[key,on,off]])=>{
      const element=document.querySelector(`.ctl-zone[data-zone="${zone}"]`);if(!element)return;
      const value=s[key];
      element.classList.toggle('on',value===true);
      element.classList.toggle('unknown',value==null);
      if(zone==='lock')element.classList.toggle('unlocked',value===false);
      element.setAttribute('aria-label',names[zone]+'：'+(value==null?'状态未知':value?on:off)+'，点击查看操作');
    });
  }
  /* 模块小窗滑块:点击直接发开/关指令,滑块位置与卡片发光即状态 */
  const SWITCH={
    climate:{on:['auto_conditioning_start',{}],off:['auto_conditioning_stop',{}],state:()=>model.states?.climate_on},
    charge:{on:['charge_start',{}],off:['charge_stop',{}],state:()=>model.states?.charging},
    lights:{on:['flash_strobe',()=>({seconds:strobeSeconds}),()=>`确认连续闪灯 ${strobeSeconds} 秒？请注意周围环境。`],off:['flash_strobe_stop',{}],state:()=>model.strobe_active},
    nap:{state:()=>active()},
  };
  function renderSwitches(){
    Object.keys(SWITCH).forEach(name=>{
      const tile=document.querySelector(`.ctl-module[data-panel="${name}"]`);if(!tile)return;
      const on=SWITCH[name].state();
      tile.classList.toggle('on',on===true);
      tile.classList.toggle('unknown',on==null);
      const sw=tile.querySelector('.ctl-switch');if(!sw)return;
      sw.classList.toggle('on',on===true);
      sw.setAttribute('aria-checked',on===true?'true':'false');
      sw.disabled=busy||!canWrite();
    });
  }
  function render(){
    const s=model.states||{};
    $('ctl-main').hidden=false;
    $('ctl-setup').style.display=model.ever_configured||model.configured?'none':'grid';
    $('ctl-main').classList.toggle('preview',!model.configured);
    $('ctl-backend').textContent=model.configured?'控制已接入':model.ever_configured?'配置未完成':'尚未接入';
    renderZones();
    renderSwitches();
    $('ctl-model-temp').textContent=num(s.climate_temp);
    $('ctl-model-inside').textContent='车内 '+num(s.inside_temp);
    $('ctl-module-climate').textContent=tri(s.climate_on)+' · 设定 '+num(s.climate_temp);
    $('ctl-module-charge').textContent=tri(s.charging,'充电中','未充电')+(s.charge_limit==null?'':' · 上限 '+s.charge_limit+'%');
    $('ctl-module-lights').textContent=model.strobe_active?'连续闪灯中':'闪灯 / 鸣笛';
    $('ctl-live-note').textContent=s.reported_at?`${s.source==='fleet'?'车辆状态':'TeslaMate 上报'} · ${new Date(s.reported_at).toLocaleTimeString('zh-CN')} · 未上报项目显示未知`:'当前状态未知；点击刷新获取车辆上报，休眠或离线时不会自动唤醒。';
    $('ctl-refresh').disabled=busy||!canWrite();
    $('ctl-state').textContent=model.role==='viewer'?'只读账号：可以查看状态，不能操作车辆。':vehicle.state?`车辆：${({online:'在线',asleep:'休眠',offline:'离线',driving:'行驶中',charging:'充电中'})[vehicle.state]||vehicle.state}`:'';
    renderNap();
  }
  async function load(){
    if(loading)return;loading=true;
    try{model=await api('status');render();}catch(e){message(e.message,true);}finally{loading=false;}
  }
  async function refresh(){
    if(!canWrite()||busy)return;
    busy=true;render();message('正在读取车辆状态…');
    try{const data=await api('refresh',{});model.states=data.states;render();message(data.ok?'车辆状态已更新':data.detail,!data.ok);}
    catch(e){message(e.message,true);}finally{busy=false;render();}
  }
  const btn=(label,cmd,args={},confirm='')=>({label,cmd,args,confirm});
  function addButtons(items){
    const row=document.createElement('div');row.className='ctl-actions';
    items.forEach(item=>{const b=document.createElement('button');b.textContent=item.label;b.type='button';b.disabled=!canWrite();b.addEventListener('click',()=>command(item));row.appendChild(b);});
    $('ctl-dialog-body').appendChild(row);
  }
  /* 开关行:滑块即开/关,滑动与变色即状态;flip 返回新的开态(null=保持不变) */
  function switchRow(label,hint,isOn,flip){
    const row=document.createElement('div');row.className='ctl-switch-row';
    const box=document.createElement('div');
    const span=document.createElement('span');span.textContent=label;box.appendChild(span);
    if(hint){const small=document.createElement('small');small.textContent=hint;box.appendChild(small);}
    row.appendChild(box);
    const sw=document.createElement('button');sw.type='button';sw.className='ctl-switch';sw.setAttribute('role','switch');
    sw.setAttribute('aria-checked',isOn?'true':'false');sw.setAttribute('aria-label',label+'开关');sw.disabled=!canWrite();
    sw.classList.toggle('on',isOn);sw.appendChild(document.createElement('i'));
    sw.addEventListener('click',async()=>{
      if(busy||sw.disabled)return;
      const target=sw.getAttribute('aria-checked')!=='true';
      sw.classList.add('busy');
      const next=await flip(target);
      sw.classList.remove('busy');
      if(next==null)return;
      sw.classList.toggle('on',next);sw.setAttribute('aria-checked',next?'true':'false');
    });
    row.appendChild(sw);$('ctl-dialog-body').appendChild(row);
  }
  function tip(text){const p=document.createElement('p');p.className='ctl-tip';p.textContent=text;$('ctl-dialog-body').appendChild(p);}
  function input(id,label,value,min,max,step=1){
    const l=document.createElement('label');l.textContent=label;const i=document.createElement('input');i.id=id;i.type='number';i.min=min;i.max=max;i.step=step;i.value=value;i.inputMode='decimal';l.appendChild(i);$('ctl-dialog-body').appendChild(l);return i;
  }
  function open(name){
    const s=model.states||{};const body=$('ctl-dialog-body');body.textContent='';$('ctl-dialog-message').textContent='';
    const titles={climate:'空调温度',charge:'充电控制',lights:'车灯与鸣笛',nap:'午休模式',lock:'车锁',sentry:'哨兵模式',windows:'车窗',chargeport:'充电口',frunk:'前备箱',trunk:'后备箱'};
    $('ctl-dialog-title').textContent=titles[name]||'车辆操作';
    $('ctl-dialog-state').textContent=canWrite()?'操作将发送到车辆；关闭窗口不会取消已发送的指令。':model.role==='viewer'?'当前为只读账号。':'请先在个人中心完成控制配置。';
    const flipCmd=(onCmd,offCmd)=>(async target=>{
      const spec=target?onCmd:offCmd;
      const result=await command({cmd:spec[0],args:typeof spec[1]==='function'?spec[1]():spec[1],confirm:spec[2]||''});
      return result&&result.ok?target:null;
    });
    if(name==='climate'){
      tip(`当前空调：${tri(s.climate_on)} · 车内 ${num(s.inside_temp)} · 设定 ${num(s.climate_temp)}`);
      input('ctl-temp-input','设定温度（15–30°C）',s.climate_temp??21.5,15,30,.5);
      addButtons([btn('设置温度','set_temps')]);
      switchRow('空调','开启后按设定温度运转',s.climate_on===true,flipCmd(['auto_conditioning_start',{}],['auto_conditioning_stop',{}]));
    }else if(name==='charge'){
      tip(`当前：${tri(s.charging,'充电中','未充电')} · ${tri(s.cable,'已插枪','未插枪')}`);
      input('ctl-limit-input','充电上限（50–100%）',s.charge_limit??80,50,100,1);
      addButtons([btn('设置上限','set_charge_limit')]);
      switchRow('充电','开始或停止当前充电',s.charging===true,flipCmd(['charge_start',{}],['charge_stop',{}]));
    }else if(name==='lights'){
      addButtons([btn('闪灯一次','flash_lights'),btn('鸣笛一次','honk_horn',{},'确认鸣笛？请注意周围环境。')]);
      const segLabel=document.createElement('p');segLabel.className='ctl-tip';segLabel.textContent='连续闪灯时长（仅选择，不发送）：';$('ctl-dialog-body').appendChild(segLabel);
      const seg=document.createElement('div');seg.className='ctl-seg';
      [10,30,60].forEach(seconds=>{
        const b=document.createElement('button');b.type='button';b.textContent=seconds+' 秒';b.classList.toggle('on',seconds===strobeSeconds);
        b.addEventListener('click',()=>{strobeSeconds=seconds;seg.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));});
        seg.appendChild(b);
      });
      $('ctl-dialog-body').appendChild(seg);
      switchRow('连续闪灯','按所选时长闪灯，可随时关闭',model.strobe_active===true,flipCmd(['flash_strobe',()=>({seconds:strobeSeconds}),()=>`确认连续闪灯 ${strobeSeconds} 秒？`],['flash_strobe_stop',{}]));
      tip('连续闪灯由服务器逐次发送，频率受网络和车辆响应限制。');
    }else if(name==='nap'){
      const p=document.createElement('p');p.id='ctl-nap-status';body.appendChild(p);
      input('ctl-nap-minutes','午休时长（5–180 分钟）',napMinutes(),5,180);
      tip('现在开启露营模式，到设定时间关闭；关闭网页后计时继续。需车辆在线并支持露营模式。已有宠物、驻车空调或露营模式时不会覆盖。');
      switchRow('午休模式','开启 = 现在进入露营模式，到时自动关闭',active(),async target=>{
        if(target){const field=$('ctl-nap-minutes');if(!field.reportValidity()||!field.value)return null;await nap(true,Number(field.value));}
        else await nap(false);
        return active();  // 滑块始终同步到实际状态(取消/失败时弹回原位)
      });
      tip('服务器或车辆断网会延迟关闭；界面会显示重试状态，请在 Tesla App 确认。结束只退出露营模式，不额外发送关闭空调指令。');renderNap();
    }else if(name==='frunk'||name==='trunk'){
      const key=name==='frunk'?'frunk_open':'trunk_open';
      tip('当前状态：'+tri(s[key],'已打开','已关闭'));
      addButtons(name==='frunk'
        ?[btn('打开前备箱','actuate_trunk',{which_trunk:'front'},'确认打开前备箱？请确认车辆停稳且周围安全。')]
        :[btn('操作后备箱','actuate_trunk',{which_trunk:'rear'},'确认开合后备箱？请确认周围有足够空间。')]);
    }else{
      const specs={
        lock:{label:'车锁',key:'locked',triOn:'已锁',triOff:'未锁',on:['door_lock',{}],off:['door_unlock',{},'确认解锁车辆？']},
        sentry:{label:'哨兵模式',key:'sentry',triOn:'开启',triOff:'关闭',on:['set_sentry_mode',{on:true}],off:['set_sentry_mode',{on:false}]},
        windows:{label:'车窗通风',key:'windows_open',triOn:'通风中',triOff:'已关闭',on:['window_control',{command:'vent'}],off:['window_control',{command:'close'}]},
        chargeport:{label:'充电口',key:'charge_port',triOn:'已打开',triOff:'已关闭',on:['charge_port_door_open',{}],off:['charge_port_door_close',{}]},
      };
      const spec=specs[name];if(!spec)return;
      tip('当前状态：'+tri(s[spec.key],spec.triOn,spec.triOff));
      switchRow(spec.label,'滑动即下发指令，滑块位置即当前状态',s[spec.key]===true,flipCmd(spec.on,spec.off));
    }
    if(!dialog.open)dialog.showModal();
  }
  async function command(item){
    if(busy||!canWrite())return null;
    let args=item.args;
    const inputId=item.cmd==='set_temps'?'ctl-temp-input':item.cmd==='set_charge_limit'?'ctl-limit-input':null;
    if(inputId){const i=$(inputId);if(!i.reportValidity()||!i.value)return null;args=item.cmd==='set_temps'?{driver_temp:Number(i.value)}:{percent:Number(i.value)};}
    if(item.confirm&&!confirm(typeof item.confirm==='function'?item.confirm():item.confirm))return null;
    busy=true;dialog.querySelectorAll('#ctl-dialog-body button').forEach(b=>b.disabled=true);message(SENDING);
    try{
      const result=await api('command',{cmd:item.cmd,args});
      message(result.ok?(result.woke?'车辆已唤醒，':'')+'指令已接受，请刷新确认车辆状态':result.reason||'车辆未接受指令',!result.ok);
      return result;
    }
    catch(e){message(e.message,true);return null;}
    finally{busy=false;dialog.querySelectorAll('#ctl-dialog-body button').forEach(b=>b.disabled=!canWrite());await load();}
  }
  function napMinutes(){
    const saved=parseInt(localStorage.getItem('ttv-nap-minutes'),10);
    return Number.isFinite(saved)?Math.min(180,Math.max(5,saved)):30;
  }
  async function nap(start,minutes){
    if(busy||!canWrite())return;
    if(start){
      if(!confirm(`现在开启露营模式，${minutes} 分钟后结束午休？`))return;
      localStorage.setItem('ttv-nap-minutes',String(minutes));
    }
    busy=true;render();message(start?'正在开启露营模式…':'正在结束午休…');
    try{model.nap=await api('nap/'+(start?'start':'stop'),start?{minutes}:{});message(model.nap.error||'午休设置已更新',!!model.nap.error);}
    catch(e){message(e.message,true);}finally{busy=false;await load();renderNap();}
  }
  /* 模块小窗滑块:点击直接开/关(不打开弹窗) */
  async function flipSwitch(name,sw){
    if(busy||!canWrite())return;
    const spec=SWITCH[name];const on=spec.state()===true;
    if(name==='nap'){await nap(!on,on?undefined:napMinutes());return;}
    const [cmd,argsOrFn,cfmOrFn]=on?spec.off:spec.on;
    const args=typeof argsOrFn==='function'?argsOrFn():argsOrFn;
    const cfm=typeof cfmOrFn==='function'?cfmOrFn():cfmOrFn;
    if(cfm&&!confirm(cfm))return;
    busy=true;sw.classList.add('busy');render();message(SENDING);
    try{
      const result=await api('command',{cmd,args});
      message(result.ok?(result.woke?'车辆已唤醒，':'')+'指令已接受，请刷新确认车辆状态':result.reason||'车辆未接受指令',!result.ok);
    }
    catch(e){message(e.message,true);}
    finally{sw.classList.remove('busy');busy=false;await load();}
  }
  $('ctl-refresh').addEventListener('click',refresh);
  document.querySelectorAll('[data-panel]').forEach(b=>{
    b.addEventListener('click',()=>open(b.dataset.panel));
    b.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open(b.dataset.panel);}});
  });
  document.querySelectorAll('.ctl-switch[data-switch]').forEach(sw=>{
    sw.addEventListener('click',e=>{e.stopPropagation();flipSwitch(sw.dataset.switch,sw);});
    sw.addEventListener('keydown',e=>e.stopPropagation());
  });
  document.querySelectorAll('.ctl-car .ctl-zone').forEach(z=>{
    const show=()=>open(['flash','honk'].includes(z.dataset.zone)?'lights':z.dataset.zone);
    z.addEventListener('click',show);z.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();show();}});
  });
  $('ctl-dialog-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  window.TeslaControl={load,overview(value){vehicle=value||{};render();}};
  // Refresh cached state only; querying Tesla is explicit to avoid continuous billed polling.
  setInterval(()=>{if(!document.hidden&&$('page-control').classList.contains('active'))load();},15000);
  setInterval(renderNap,1000);
  load();
})();
