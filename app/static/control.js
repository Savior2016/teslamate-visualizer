(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  let model={configured:false,role:'viewer',states:{},nap:{}}, busy=false, loading=false, vehicle={};
  const dialog=$('ctl-dialog');
  const tri=(value,on='开启',off='关闭')=>value==null?'未知':value?on:off;
  const num=value=>value==null?'—':Number(value).toFixed(1)+'°C';
  const phases={starting:'正在开启',active:'午休中',stopping:'正在结束',retrying:'结束待确认',completed:'已结束',failed:'未开启'};
  const active=()=>['starting','active','stopping','retrying'].includes(model.nap?.phase);
  const canWrite=()=>model.configured&&model.role==='admin';
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
    if($('ctl-nap-stop'))$('ctl-nap-stop').disabled=busy||!canWrite()||!active();
    if($('ctl-nap-start'))$('ctl-nap-start').disabled=busy||!canWrite()||active();
  }
  function render(){
    const s=model.states||{};
    $('ctl-main').hidden=false;
    $('ctl-setup').style.display=model.ever_configured||model.configured?'none':'grid';
    $('ctl-main').classList.toggle('preview',!model.configured);
    $('ctl-backend').textContent=model.configured?'控制已接入':model.ever_configured?'配置未完成':'尚未接入';
    const labels={lock:['locked','已锁','未锁'],sentry:['sentry','哨兵·开','哨兵·关'],windows:['windows_open','车窗·开','车窗·关'],chargeport:['charge_port','充电口·开','充电口·关'],frunk:['frunk_open','前备箱·开','前备箱·关'],trunk:['trunk_open','后备箱·开','后备箱·关'],climate:['climate_on','空调开启','空调关闭']};
    const names={lock:'车锁',sentry:'哨兵',windows:'车窗',chargeport:'充电口',frunk:'前备箱',trunk:'后备箱',climate:'空调'};
    Object.entries(labels).forEach(([zone,[key,on,off]])=>{
      const element=document.querySelector(`.ctl-zone[data-zone="${zone}"]`);if(!element)return;
      const text=s[key]==null?names[zone]+'·未知':s[key]?on:off;
      element.classList.toggle('on',s[key]===true);element.classList.toggle('unknown',s[key]==null);
      const label=element.querySelector('.zone-lab');if(label)label.textContent=text;
      element.setAttribute('aria-label',text+'，点击查看操作');
    });
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
  function tip(text){const p=document.createElement('p');p.className='ctl-tip';p.textContent=text;$('ctl-dialog-body').appendChild(p);}
  function input(id,label,value,min,max,step=1){
    const l=document.createElement('label');l.textContent=label;const i=document.createElement('input');i.id=id;i.type='number';i.min=min;i.max=max;i.step=step;i.value=value;i.inputMode='decimal';l.appendChild(i);$('ctl-dialog-body').appendChild(l);return i;
  }
  function open(name){
    const s=model.states||{};const body=$('ctl-dialog-body');body.textContent='';$('ctl-dialog-message').textContent='';
    const titles={climate:'空调温度',charge:'充电控制',lights:'车灯与鸣笛',nap:'午休模式',lock:'车锁',sentry:'哨兵模式',windows:'车窗',chargeport:'充电口',frunk:'前备箱',trunk:'后备箱'};
    $('ctl-dialog-title').textContent=titles[name]||'车辆操作';
    $('ctl-dialog-state').textContent=canWrite()?'操作将发送到车辆；关闭窗口不会取消已发送的指令。':model.role==='viewer'?'当前为只读账号。':'请先在个人中心完成控制配置。';
    if(name==='climate'){
      tip(`当前空调：${tri(s.climate_on)} · 车内 ${num(s.inside_temp)} · 设定 ${num(s.climate_temp)}`);
      input('ctl-temp-input','设定温度（15–30°C）',s.climate_temp??21.5,15,30,.5);
      addButtons([btn('设置温度','set_temps'),btn('开启空调','auto_conditioning_start'),btn('关闭空调','auto_conditioning_stop')]);
    }else if(name==='charge'){
      tip(`当前：${tri(s.charging,'充电中','未充电')} · ${tri(s.cable,'已插枪','未插枪')}`);
      input('ctl-limit-input','充电上限（50–100%）',s.charge_limit??80,50,100,1);
      addButtons([btn('设置上限','set_charge_limit'),btn('开始充电','charge_start'),btn('停止充电','charge_stop')]);
    }else if(name==='lights'){
      addButtons([btn('闪灯一次','flash_lights'),btn('鸣笛一次','honk_horn',{},'确认鸣笛？请注意周围环境。')]);
      addButtons([10,30,60].map(seconds=>btn('连续 '+seconds+' 秒','flash_strobe',{seconds},`确认连续闪灯 ${seconds} 秒？`)));
      addButtons([btn('停止连续闪灯','flash_strobe_stop')]);tip('连续闪灯由服务器逐次发送，频率受网络和车辆响应限制。');
    }else if(name==='nap'){
      const p=document.createElement('p');p.id='ctl-nap-status';body.appendChild(p);
      input('ctl-nap-minutes','午休时长（5–180 分钟）',30,5,180);
      tip('现在开启露营模式，到设定时间关闭；关闭网页后计时继续。需车辆在线并支持露营模式。已有宠物、驻车空调或露营模式时不会覆盖。');
      const row=document.createElement('div');row.className='ctl-actions';
      [['ctl-nap-start','开始午休',true],['ctl-nap-stop','立即结束',false]].forEach(([id,label,start])=>{const b=document.createElement('button');b.id=id;b.textContent=label;b.addEventListener('click',()=>nap(start));row.appendChild(b);});body.appendChild(row);
      tip('服务器或车辆断网会延迟关闭；界面会显示重试状态，请在 Tesla App 确认。结束只退出露营模式，不额外发送关闭空调指令。');renderNap();
    }else{
      const groups={lock:[btn('锁车','door_lock'),btn('解锁','door_unlock',{},'确认解锁车辆？')],sentry:[btn('开启哨兵','set_sentry_mode',{on:true}),btn('关闭哨兵','set_sentry_mode',{on:false})],windows:[btn('通风','window_control',{command:'vent'}),btn('关闭车窗','window_control',{command:'close'})],chargeport:[btn('打开充电口','charge_port_door_open'),btn('关闭充电口','charge_port_door_close')],frunk:[btn('打开前备箱','actuate_trunk',{which_trunk:'front'},'确认打开前备箱？请确认车辆停稳且周围安全。')],trunk:[btn('操作后备箱','actuate_trunk',{which_trunk:'rear'},'确认开合后备箱？请确认周围有足够空间。')]};
      const key={lock:'locked',sentry:'sentry',windows:'windows_open',chargeport:'charge_port',frunk:'frunk_open',trunk:'trunk_open'}[name];
      tip('当前状态：'+tri(s[key],name==='lock'?'已锁':'开启',name==='lock'?'未锁':'关闭'));addButtons(groups[name]||[]);
    }
    if(!dialog.open)dialog.showModal();
  }
  async function command(item){
    if(busy||!canWrite())return;
    let args=item.args;
    const inputId=item.cmd==='set_temps'?'ctl-temp-input':item.cmd==='set_charge_limit'?'ctl-limit-input':null;
    if(inputId){const i=$(inputId);if(!i.reportValidity()||!i.value)return;args=item.cmd==='set_temps'?{driver_temp:Number(i.value)}:{percent:Number(i.value)};}
    if(item.confirm&&!confirm(item.confirm))return;
    busy=true;dialog.querySelectorAll('#ctl-dialog-body button').forEach(b=>b.disabled=true);message('正在发送指令…');
    try{const result=await api('command',{cmd:item.cmd,args});message(result.ok?'指令已接受，请刷新确认车辆状态':result.reason||'车辆未接受指令',!result.ok);}
    catch(e){message(e.message,true);}finally{busy=false;dialog.querySelectorAll('#ctl-dialog-body button').forEach(b=>b.disabled=!canWrite());await load();}
  }
  async function nap(start){
    if(busy||!canWrite())return;
    const field=$('ctl-nap-minutes');if(start&&(!field.reportValidity()||!field.value))return;
    if(start&&!confirm(`现在开启露营模式，${field.value} 分钟后结束午休？`))return;
    busy=true;renderNap();message(start?'正在开启露营模式…':'正在结束午休…');
    try{model.nap=await api('nap/'+(start?'start':'stop'),start?{minutes:Number(field.value)}:{});message(model.nap.error||'午休设置已更新',!!model.nap.error);}
    catch(e){message(e.message,true);}finally{busy=false;await load();renderNap();}
  }
  $('ctl-refresh').addEventListener('click',refresh);
  document.querySelectorAll('[data-panel]').forEach(b=>b.addEventListener('click',()=>open(b.dataset.panel)));
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
