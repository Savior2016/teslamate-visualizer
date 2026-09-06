(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  let model={configured:false,role:'viewer',states:{},nap:{}}, busy=false, loading=false, vehicle={}, strobeSeconds=30;
  const dialog=$('ctl-dialog'), confirmDlg=$('ctl-confirm');
  const tri=(value,on='开启',off='关闭')=>value==null?'未知':value?on:off;
  const num=value=>value==null?'—':Number(value).toFixed(1)+'°C';
  const phases={starting:'正在开启',active:'午休中',stopping:'正在结束',retrying:'结束待确认',completed:'已结束',failed:'未开启'};
  const active=()=>['starting','active','stopping','retrying'].includes(model.nap?.phase);
  const canWrite=()=>model.configured&&model.role==='admin';
  const SENDING='正在发送指令（车辆休眠时会先自动唤醒）…';
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
  /* 二次确认弹窗(仅前/后备箱等风险操作使用),返回 Promise<bool> */
  function confirmBox(title,text,yes){
    return new Promise(resolve=>{
      $('ctl-confirm-title').textContent=title;
      $('ctl-confirm-text').textContent=text;
      $('ctl-confirm-yes').textContent=yes||'确认';
      const done=v=>{if(confirmDlg.open)confirmDlg.close();resolve(v);};
      $('ctl-confirm-yes').onclick=()=>done(true);
      $('ctl-confirm-no').onclick=()=>done(false);
      confirmDlg.oncancel=()=>done(false);
      confirmDlg.onclick=e=>{if(e.target===confirmDlg)done(false);};
      confirmDlg.showModal();
    });
  }
  function guardWrite(){
    if(canWrite())return true;
    message(model.configured?'只读账号：仅可查看状态。':'尚未接入车辆控制：请先在个人中心完成配置。',true);
    return false;
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
      let value=s[key];
      if(zone==='chargeport'&&s.charging===true)value=true;  // 充电中充电口必然打开:同步亮绿
      element.classList.toggle('on',value===true);
      element.classList.toggle('unknown',value==null);
      if(zone==='lock')element.classList.toggle('unlocked',value===false);
      element.setAttribute('aria-label',names[zone]+'：'+(value==null?'状态未知':value?on:off)+'，点击查看操作');
    });
  }
  /* 滑动开关:右滑开启、回滑关闭(凹槽轨道 + 立体旋钮,滑动本身就是确认,不再弹确认框);
     momentary=true 时滑动触发一次操作后旋钮弹回。onFire(target) 须返回最终开态(bool)。 */
  function makeSlide({icon='',color='',labels=['滑动开启','已开启 · 回滑关闭'],momentary=false,onFire}){
    const root=document.createElement('div');root.className='ctl-slide'+(icon?' ic-'+icon:'');
    if(color)root.style.setProperty('--mc',color);
    root.setAttribute('role','switch');root.tabIndex=0;
    const fill=document.createElement('i');fill.className='ctl-slide-fill';
    const lab=document.createElement('small');lab.className='ctl-slide-lab';
    const knob=document.createElement('i');knob.className='ctl-slide-knob';
    root.append(fill,lab,knob);
    let on=false,sending=false,progress=0,dragging=false,startX=0,startP=0,travel=1;
    function paint(){
      if(!dragging)travel=Math.max(1,root.clientWidth-knob.offsetWidth-6);
      knob.style.transform=`translateX(${(travel*progress).toFixed(1)}px)`;
      fill.style.width=(progress*100)+'%';
      root.classList.toggle('on',on);
      root.setAttribute('aria-checked',on?'true':'false');
      lab.textContent=on?labels[1]:labels[0];
    }
    async function commit(target){
      if(sending||busy)return;
      on=target;progress=on?1:0;paint();
      sending=true;root.classList.add('busy');
      let final=target;
      try{final=(await onFire(target))===true;}
      finally{sending=false;root.classList.remove('busy');}
      on=final;progress=on?1:0;paint();
    }
    function fireOnce(){
      if(sending||busy)return;
      progress=1;paint();
      setTimeout(()=>{if(!dragging){progress=0;paint();}},200);
      onFire();
    }
    root.addEventListener('pointerdown',e=>{
      if(sending||busy)return;
      dragging=true;startX=e.clientX;startP=progress;
      travel=Math.max(1,root.clientWidth-knob.offsetWidth-6);
      root.classList.add('drag');root.setPointerCapture(e.pointerId);
    });
    root.addEventListener('pointermove',e=>{
      if(!dragging)return;
      progress=Math.min(1,Math.max(0,startP+(e.clientX-startX)/travel));paint();
    });
    const release=()=>{
      if(!dragging)return;dragging=false;root.classList.remove('drag');
      if(momentary){const hit=progress>0.7;progress=0;paint();if(hit)fireOnce();return;}
      const target=progress>0.5;
      if(target!==on)commit(target);else{progress=on?1:0;paint();}
    };
    root.addEventListener('pointerup',release);
    root.addEventListener('pointercancel',release);
    root.addEventListener('keydown',e=>{
      if(e.key!=='Enter'&&e.key!==' ')return;
      e.preventDefault();
      momentary?fireOnce():commit(!on);
    });
    paint();
    return {el:root,
      set(v){if(sending||dragging)return;on=v===true;progress=on?1:0;paint();},
      get:()=>on};
  }
  /* 模块瓦片:名称/状态 + 右上角详细设置 + 底部滑动开关(整卡点亮即状态) */
  const SWITCH={
    climate:{on:['auto_conditioning_start',{}],off:['auto_conditioning_stop',{}],state:()=>model.states?.climate_on},
    charge:{on:['charge_start',{}],off:['charge_stop',{}],state:()=>model.states?.charging},
    lights:{on:['flash_strobe',()=>({seconds:strobeSeconds})],off:['flash_strobe_stop',{}],state:()=>model.strobe_active},
    nap:{state:()=>active()},
  };
  const TILE_META={
    climate:{icon:'climate',color:'var(--series-1)',labels:['滑动开启','空调运行中']},
    charge:{icon:'charge',color:'var(--cat-charge)',labels:['滑动开启','充电中']},
    lights:{icon:'lights',color:'var(--series-4)',labels:['滑动开启','闪灯中']},
    nap:{icon:'nap',color:'var(--cat-idle)',labels:['滑动开启','午休中']},
  };
  const tileSlides={};
  function renderSwitches(){
    Object.keys(SWITCH).forEach(name=>{
      const tile=document.querySelector(`.ctl-module[data-panel="${name}"]`);if(!tile)return;
      const on=SWITCH[name].state();
      tile.classList.toggle('on',on===true);
      tile.classList.toggle('unknown',on==null);
      tileSlides[name]?.set(on===true);
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
    $('ctl-live-note').textContent=s.reported_at?`${s.source==='fleet'?'车辆状态':'TeslaMate 上报'} · ${new Date(s.reported_at).toLocaleTimeString('zh-CN')}`:'点击刷新读取车辆当前状态。';
    $('ctl-refresh').disabled=busy||!canWrite();
    $('ctl-audit').disabled=model.role!=='admin';
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
  const btn=(label,cmd,args={})=>({label,cmd,args});
  function addButtons(items){
    const row=document.createElement('div');row.className='ctl-actions';
    items.forEach(item=>{const b=document.createElement('button');b.textContent=item.label;b.type='button';b.disabled=!canWrite();b.addEventListener('click',()=>command(item));row.appendChild(b);});
    $('ctl-dialog-body').appendChild(row);
  }
  /* 弹窗开关行:标签 + 滑动开关;flip 返回新的开态(null=保持不变/弹回) */
  function slideRow(label,hint,isOn,flip,icon,color,labels){
    const wrap=document.createElement('div');wrap.className='ctl-slide-row';
    const head=document.createElement('div');head.className='ctl-slide-row-head';
    const span=document.createElement('span');span.textContent=label;head.appendChild(span);
    if(hint){const small=document.createElement('small');small.textContent=hint;head.appendChild(small);}
    wrap.appendChild(head);
    const s=makeSlide({icon,color,labels:labels||['滑动开启','已开启 · 回滑关闭'],onFire:async target=>{
      if(!guardWrite())return isOn;
      const next=await flip(target);return next==null?isOn:next;
    }});
    s.set(isOn);s.el.setAttribute('aria-label',label+'开关');
    wrap.appendChild(s.el);$('ctl-dialog-body').appendChild(wrap);
    return s;
  }
  function tip(text){const p=document.createElement('p');p.className='ctl-tip';p.textContent=text;$('ctl-dialog-body').appendChild(p);}
  function input(id,label,value,min,max,step=1){
    const l=document.createElement('label');l.textContent=label;const i=document.createElement('input');i.id=id;i.type='number';i.min=min;i.max=max;i.step=step;i.value=value;i.inputMode='decimal';l.appendChild(i);$('ctl-dialog-body').appendChild(l);return i;
  }
  function open(name){
    const s=model.states||{};const body=$('ctl-dialog-body');body.textContent='';$('ctl-dialog-message').textContent='';
    const titles={climate:'空调温度',charge:'充电控制',lights:'车灯与鸣笛',nap:'午休模式',lock:'车锁',sentry:'哨兵模式',windows:'车窗',chargeport:'充电口',frunk:'前备箱',trunk:'后备箱'};
    $('ctl-dialog-title').textContent=titles[name]||'车辆操作';
    const stateText=canWrite()?'':(model.role==='viewer'?'只读账号，仅可查看状态。':'请先在个人中心完成控制配置。');
    $('ctl-dialog-state').textContent=stateText;$('ctl-dialog-state').hidden=!stateText;
    const flipCmd=(onCmd,offCmd)=>(async target=>{
      const spec=target?onCmd:offCmd;
      const result=await command({cmd:spec[0],args:typeof spec[1]==='function'?spec[1]():spec[1]});
      return result&&result.ok?target:null;
    });
    if(name==='climate'){
      input('ctl-temp-input','设定温度（15–30°C）',s.climate_temp??21.5,15,30,.5);
      addButtons([btn('设置温度','set_temps')]);
      slideRow('空调','',s.climate_on===true,flipCmd(['auto_conditioning_start',{}],['auto_conditioning_stop',{}]),'climate','var(--series-1)',['滑动开启','空调运行中']);
    }else if(name==='charge'){
      input('ctl-limit-input','充电上限（50–100%）',s.charge_limit??80,50,100,1);
      addButtons([btn('设置上限','set_charge_limit')]);
      slideRow('充电','',s.charging===true,flipCmd(['charge_start',{}],['charge_stop',{}]),'charge','var(--cat-charge)',['滑动开始充电','充电中']);
    }else if(name==='lights'){
      addButtons([btn('闪灯一次','flash_lights'),btn('鸣笛一次','honk_horn')]);
      const segLabel=document.createElement('p');segLabel.className='ctl-tip';segLabel.textContent='连续闪灯时长';$('ctl-dialog-body').appendChild(segLabel);
      const seg=document.createElement('div');seg.className='ctl-seg';
      [10,30,60].forEach(seconds=>{
        const b=document.createElement('button');b.type='button';b.textContent=seconds+' 秒';b.classList.toggle('on',seconds===strobeSeconds);
        b.addEventListener('click',()=>{strobeSeconds=seconds;seg.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));});
        seg.appendChild(b);
      });
      $('ctl-dialog-body').appendChild(seg);
      slideRow('连续闪灯','',model.strobe_active===true,flipCmd(['flash_strobe',()=>({seconds:strobeSeconds})],['flash_strobe_stop',{}]),'lights','var(--series-4)',['滑动开始闪灯','闪灯中']);
    }else if(name==='nap'){
      const p=document.createElement('p');p.id='ctl-nap-status';body.appendChild(p);
      input('ctl-nap-minutes','午休时长（5–180 分钟）',napMinutes(),5,180);
      slideRow('午休模式','',active(),async target=>{
        if(target){const field=$('ctl-nap-minutes');if(!field.reportValidity()||!field.value)return null;await nap(true,Number(field.value));}
        else await nap(false);
        return active();  // 滑块始终同步到实际状态(取消/失败时弹回原位)
      },'nap','var(--cat-idle)',['滑动开启','午休中']);
      tip('开启露营模式，到时自动关闭；关闭网页不影响计时。');renderNap();
    }else if(name==='frunk'||name==='trunk'){
      const isFrunk=name==='frunk';
      tip('当前状态：'+tri(s[isFrunk?'frunk_open':'trunk_open'],'已打开','已关闭'));
      const slide=makeSlide({icon:isFrunk?'frunk':'trunk',color:'var(--series-2)',labels:[isFrunk?'滑动打开前备箱':'滑动开合后备箱',''],momentary:true,onFire:async()=>{
        if(!guardWrite())return;
        const yes=await confirmBox(isFrunk?'打开前备箱？':'开合后备箱？','请确认车辆停稳，周围无障碍、无人员靠近。',isFrunk?'确认打开':'确认开合');
        if(!yes)return;
        await command({cmd:'actuate_trunk',args:{which_trunk:isFrunk?'front':'rear'}});
      }});
      slide.el.setAttribute('aria-label',(isFrunk?'前备箱':'后备箱')+'操作');
      $('ctl-dialog-body').appendChild(slide.el);
    }else{
      const specs={
        lock:{label:'车锁',key:'locked',on:['door_lock',{}],off:['door_unlock',{}],icon:'lock',color:'var(--series-3)',labels:['滑动解锁','已锁定']},
        sentry:{label:'哨兵模式',key:'sentry',on:['set_sentry_mode',{on:true}],off:['set_sentry_mode',{on:false}],icon:'sentry',color:'var(--cat-sentry)',labels:['滑动开启','哨兵中']},
        windows:{label:'车窗通风',key:'windows_open',on:['window_control',{command:'vent'}],off:['window_control',{command:'close'}],icon:'windows',color:'var(--seq-blue-300)',labels:['滑动开启通风','通风中']},
        chargeport:{label:'充电口',key:'charge_port',on:['charge_port_door_open',{}],off:['charge_port_door_close',{}],icon:'chargeport',color:'var(--cat-charge)',labels:['滑动打开','已打开']},
      };
      const spec=specs[name];if(!spec)return;
      slideRow(spec.label,'',s[spec.key]===true,flipCmd(spec.on,spec.off),spec.icon,spec.color,spec.labels);
      if(name==='sentry')renderSchedule();
    }
    if(!dialog.open)dialog.showModal();
  }
  async function command(item){
    if(busy||!canWrite())return null;
    let args=item.args;
    const inputId=item.cmd==='set_temps'?'ctl-temp-input':item.cmd==='set_charge_limit'?'ctl-limit-input':null;
    if(inputId){const i=$(inputId);if(!i.reportValidity()||!i.value)return null;args=item.cmd==='set_temps'?{driver_temp:Number(i.value)}:{percent:Number(i.value)};}
    busy=true;dialog.querySelectorAll('#ctl-dialog-body button').forEach(b=>b.disabled=true);message(SENDING);
    try{
      const result=await api('command',{cmd:item.cmd,args});
      message(result.ok?(result.woke?'车辆已唤醒，':'')+'指令已接受':result.reason||'车辆未接受指令',!result.ok);
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
    if(start)localStorage.setItem('ttv-nap-minutes',String(minutes));
    busy=true;render();message(start?'正在开启露营模式…':'正在结束午休…');
    try{model.nap=await api('nap/'+(start?'start':'stop'),start?{minutes}:{});message(model.nap.error||'午休设置已更新',!!model.nap.error);}
    catch(e){message(e.message,true);}finally{busy=false;await load();renderNap();}
  }
  /* 模块瓦片滑动开关:右滑开、回滑关(无确认窗) */
  async function flipSwitch(name,target){
    const cur=SWITCH[name].state()===true;
    if(busy||!guardWrite())return cur;
    if(name==='nap'){await nap(target,target?napMinutes():undefined);return active();}
    const [cmd,argsOrFn]=target?SWITCH[name].on:SWITCH[name].off;
    const args=typeof argsOrFn==='function'?argsOrFn():argsOrFn;
    busy=true;message(SENDING);
    try{
      const result=await api('command',{cmd,args});
      message(result.ok?(result.woke?'车辆已唤醒，':'')+'指令已接受':result.reason||'车辆未接受指令',!result.ok);
      return result.ok?target:cur;
    }
    catch(e){message(e.message,true);return cur;}
    finally{busy=false;await load();}
  }
  /* 定时哨兵:多个每日时段,到点自动开/关;整表提交保存 */
  let sentrySlots=[];
  async function saveSlots(slots){
    await api('sentry-schedule',{slots:slots.map(s=>({start:s.start,end:s.end,enabled:s.enabled!==false}))});
  }
  function renderSchedule(){
    const wrap=document.createElement('div');wrap.className='ctl-sched';
    const head=document.createElement('p');head.className='ctl-tip';head.textContent='定时哨兵:可添加多个时段(支持跨夜,如 22:00 – 07:00),进入时段自动开启、离开时段自动关闭。';wrap.appendChild(head);
    const list=document.createElement('div');list.className='ctl-sched-list';wrap.appendChild(list);
    function redraw(){
      list.textContent='';
      if(!sentrySlots.length){
        const empty=document.createElement('p');empty.className='ctl-tip';empty.textContent='暂无时段。';list.appendChild(empty);
      }
      sentrySlots.forEach(slot=>{
        const row=document.createElement('div');row.className='ctl-sched-row';
        const tgl=document.createElement('button');tgl.type='button';tgl.className='ctl-sched-toggle'+(slot.enabled!==false?' on':'');tgl.textContent=slot.enabled!==false?'已启用':'已停用';tgl.disabled=!canWrite();
        const txt=document.createElement('span');txt.textContent=`${slot.start} – ${slot.end}`;
        const del=document.createElement('button');del.type='button';del.textContent='删除';del.disabled=!canWrite();
        tgl.addEventListener('click',async()=>{
          const prev=slot.enabled!==false;slot.enabled=!prev;
          try{await saveSlots(sentrySlots);}catch(e){slot.enabled=prev;message(e.message,true);}
          redraw();
        });
        del.addEventListener('click',async()=>{
          const keep=sentrySlots;sentrySlots=sentrySlots.filter(x=>x!==slot);
          try{await saveSlots(sentrySlots);}catch(e){sentrySlots=keep;message(e.message,true);}
          redraw();
        });
        row.append(tgl,txt,del);list.appendChild(row);
      });
    }
    const add=document.createElement('div');add.className='ctl-sched-add';
    const a=document.createElement('input');a.type='time';a.value='22:00';a.setAttribute('aria-label','开始时间');
    const b=document.createElement('input');b.type='time';b.value='07:00';b.setAttribute('aria-label','结束时间');
    const plus=document.createElement('button');plus.type='button';plus.textContent='添加时段';plus.disabled=!canWrite();
    plus.addEventListener('click',async()=>{
      if(!guardWrite())return;
      if(!a.value||!b.value)return;
      if(a.value===b.value){message('开始与结束时间不能相同',true);return;}
      if(sentrySlots.length>=10){message('最多 10 个时段',true);return;}
      sentrySlots=[...sentrySlots,{start:a.value,end:b.value,enabled:true}];
      try{await saveSlots(sentrySlots);message('时段已保存');}
      catch(e){sentrySlots=sentrySlots.slice(0,-1);message(e.message,true);}
      redraw();
    });
    add.append(a,b,plus);wrap.appendChild(add);
    $('ctl-dialog-body').appendChild(wrap);
    redraw();
    api('sentry-schedule').then(d=>{sentrySlots=d.slots||[];redraw();}).catch(()=>{});
  }
  /* 控制审计:指令下发记录弹窗 */
  const auditDlg=$('ctl-audit-dialog');
  const CMD_NAMES={wake_up:'唤醒车辆',door_lock:'锁车',door_unlock:'解锁',honk_horn:'鸣笛',flash_lights:'闪灯一次',flash_strobe:'连续闪灯',flash_strobe_stop:'停止闪灯',sentry_mode:'哨兵模式',set_sentry_mode:'哨兵模式',auto_conditioning_start:'开启空调',auto_conditioning_stop:'关闭空调',set_temps:'设定温度',charge_start:'开始充电',charge_stop:'停止充电',charge_port_door_open:'打开充电口',charge_port_door_close:'关闭充电口',set_charge_limit:'设置充电上限',window_control:'车窗控制',actuate_trunk:'开合前/后备箱'};
  function auditArgs(e){
    const a=e.args||{};
    if(e.cmd==='set_sentry_mode'||e.cmd==='sentry_mode')return a.on?'（开启）':'（关闭）';
    if(e.cmd==='set_temps')return `（${a.driver_temp}°C）`;
    if(e.cmd==='set_charge_limit')return `（${a.percent}%）`;
    if(e.cmd==='window_control')return a.command==='vent'?'（通风）':'（关闭）';
    if(e.cmd==='actuate_trunk')return a.which_trunk==='front'?'（前备箱）':'（后备箱）';
    if(e.cmd==='flash_strobe')return `（${a.seconds||''} 秒）`;
    return '';
  }
  async function openAudit(){
    if(model.role!=='admin'){message('只读账号：无权查看控制审计。',true);return;}
    const body=$('ctl-audit-body');body.textContent='正在读取记录…';
    if(!auditDlg.open)auditDlg.showModal();
    try{
      const data=await api('audit');
      body.textContent='';
      if(!data.entries||!data.entries.length){body.textContent='暂无记录。';return;}
      data.entries.forEach(e=>{
        const row=document.createElement('div');row.className='ctl-audit-row'+(e.ok?'':' fail');
        const when=document.createElement('time');when.textContent=new Date(e.at*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
        const what=document.createElement('span');what.className='ctl-audit-what';
        what.textContent=`${e.user} · ${CMD_NAMES[e.cmd]||e.cmd}${auditArgs(e)}${e.woke?'（先唤醒车辆）':''}`;
        const st=document.createElement('b');st.textContent=e.ok?'已接受':(e.reason||'未接受');
        row.append(when,what,st);body.appendChild(row);
      });
    }catch(e){body.textContent=e.message;}
  }
  $('ctl-audit').addEventListener('click',openAudit);
  $('ctl-audit-close').addEventListener('click',()=>auditDlg.close());
  auditDlg.addEventListener('click',e=>{if(e.target===auditDlg)auditDlg.close();});
  $('ctl-refresh').addEventListener('click',refresh);
  Object.keys(TILE_META).forEach(name=>{
    const tile=document.querySelector(`.ctl-module[data-panel="${name}"]`);if(!tile)return;
    const meta=TILE_META[name];
    const slide=makeSlide({icon:meta.icon,color:meta.color,labels:meta.labels,onFire:target=>flipSwitch(name,target)});
    slide.el.setAttribute('aria-label',tile.querySelector('span').textContent+'开关');
    tile.appendChild(slide.el);tileSlides[name]=slide;
  });
  document.querySelectorAll('.ctl-module-open').forEach(b=>{
    const name=b.closest('.ctl-module').dataset.panel;
    b.addEventListener('click',e=>{e.stopPropagation();open(name);});
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
