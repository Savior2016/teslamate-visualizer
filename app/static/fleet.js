(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let busy = false;
  let state = {};
  function needsSave() {
    return !state.secret_saved || $('fleet-client').value.trim() !== state.client_id ||
      $('fleet-region').value !== state.region || !!$('fleet-secret').value.trim();
  }
  function updateButtons() {
    const pending = needsSave();
    $('fleet-register').disabled = busy || !state.public_key;
    $('fleet-register').textContent = pending ? '保存并注册应用' : (state.registered ? '重新注册应用' : '注册应用');
    $('fleet-register-hint').textContent = !state.public_key
      ? '服务器公钥尚未就绪，请联系管理员。'
      : pending ? '先填写上方的客户端 ID、密钥和面板登录密码，再点击这里保存并注册。'
      : state.registered ? '应用已注册，可以继续下一步授权。' : '应用信息已保存，可以点击注册。';
    $('fleet-authorize').disabled = busy || pending || !state.registered;
    $('fleet-paired').disabled = busy || pending || !state.authorized;
    $('fleet-secret').required = !state.secret_saved || $('fleet-client').value.trim() !== state.client_id || $('fleet-region').value !== state.region;
  }
  async function saveConfig() {
    const changed = needsSave();
    const body = {client_id:$('fleet-client').value.trim(),client_secret:$('fleet-secret').value.trim(),region:$('fleet-region').value,password:$('fleet-password').value};
    try {
      await api('config',body);
      $('fleet-secret').value='';
      // Reflect the successful save even if the following registration request fails.
      state = {...state,client_id:body.client_id,region:body.region,secret_saved:true,
        registered:changed?false:state.registered,authorized:changed?false:state.authorized,paired:changed?false:state.paired};
    } finally { $('fleet-password').value=''; }
  }
  function message(text, error=false) { $('fleet-message').textContent=text; $('fleet-message').classList.toggle('error',error); }
  async function api(path, body) {
    const r = await fetch('/api/fleet/'+path, body === undefined ? {cache:'no-store'} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if (r.status === 401) { location.href='/login?next=%2Ffleet.html'; throw Error('请先登录'); }
    const data=await r.json();
    if (!r.ok) throw Error(r.status===403 ? (typeof data.detail==='string'?data.detail:'仅管理员可以配置控制功能') : (typeof data.detail==='string'?data.detail:'请检查填写内容'));
    return data;
  }
  async function load() {
    state=await api('status');
    $('fleet-wizard').hidden=false;
    $('fleet-origin').value=state.origin; $('fleet-redirect').value=state.redirect_uri;
    $('fleet-client').value=state.client_id; $('fleet-region').value=state.region;
    $('fleet-secret').required=!state.secret_saved;
    $('fleet-secret').placeholder=state.secret_saved?'已保存；留空保留原密钥':'粘贴客户端密钥';
    $('state-config').textContent=state.secret_saved?'已保存':'待填写';
    $('state-register').textContent=state.registered?'已注册':'待注册';
    $('state-authorize').textContent=state.authorized?'已授权':'待授权';
    $('state-pair').textContent=state.paired?'已由你确认':'待确认';
    updateButtons();
    if(state.registered) $('fleet-pair').href=state.pair_url; else $('fleet-pair').removeAttribute('href');
    $('fleet-server').textContent=state.public_key&&state.proxy_installed?'服务器公钥和签名代理文件已就绪。':'服务器接入准备尚未完成，请联系管理员部署公钥和签名代理。';
    $('fleet-ready').textContent=state.authorized&&state.paired?'接入步骤已完成，可返回控制页手动测试。实际控制结果取决于车辆在线状态与钥匙配对。':'完成前面的步骤后，返回控制页使用。';
    regionNote();
  }
  function regionNote() { $('fleet-region-note').textContent=$('fleet-region').value==='cn'?'中国大陆车辆：使用 developer.tesla.cn 创建的应用，国际站应用不能直接用于中国区。':'此地区使用 developer.tesla.com 创建的应用。请选择车辆实际所在地区。'; }
  async function action(work, done) {
    if(busy)return; busy=true;
    document.querySelectorAll('button,input,select').forEach(b=>b.disabled=true);
    message('正在处理，请稍候…');
    try { await work(); await load(); message(done); }
    catch(e) { message(e.message,true); $('fleet-message').scrollIntoView({behavior:'smooth',block:'center'}); }
    finally { busy=false; document.querySelectorAll('button,input,select').forEach(b=>b.disabled=false); updateButtons(); }
  }
  $('fleet-region').addEventListener('change',()=>{regionNote();updateButtons();});
  ['fleet-client','fleet-secret'].forEach(id=>$(id).addEventListener('input',updateButtons));
  $('fleet-config').addEventListener('submit',e=>{e.preventDefault();action(saveConfig,'应用信息已保存，请继续注册应用。');});
  $('fleet-register').addEventListener('click',()=>{
    const pending=needsSave();
    if(pending && !$('fleet-config').reportValidity()) {
      message('请先填写完整的应用信息和面板登录密码。',true);
      return;
    }
    action(async()=>{
      if(pending) await saveConfig();
      try { await api('register',{}); }
      catch(e) { await load(); throw e; }
    },'应用注册成功，可以前往 Tesla 授权。');
  });
  $('fleet-authorize').addEventListener('click',()=>action(async()=>{const r=await api('authorize',{}); const u=new URL(r.url); if(!['auth.tesla.com','auth.tesla.cn'].includes(u.hostname)||u.protocol!=='https:')throw Error('授权地址无效'); location.assign(u.href);},'正在跳转 Tesla…'));
  $('fleet-paired').addEventListener('click',()=>action(()=>api('paired',{}),'已记录配对确认，可以返回控制页面。'));
  $('fleet-disconnect-form').addEventListener('submit',e=>{e.preventDefault();if(!confirm('清除当前应用凭据和令牌？后续使用需重新接入。'))return;action(async()=>{try{await api('disconnect',{password:$('fleet-disconnect-password').value});}finally{$('fleet-disconnect-password').value='';}},'已清除接入配置。');});
  const result=new URLSearchParams(location.search).get('fleet');
  const messages={success:'Tesla 授权成功，请继续配对虚拟钥匙。',denied:'你取消了 Tesla 授权，可以重新开始。',invalid:'授权链接已过期或登录会话已变化，请重新点击授权。',failed:'令牌交换失败，请检查回调地址、区域和客户端密钥后重新授权。'};
  if(result) history.replaceState(null,'','/fleet.html');
  load().then(()=>message(messages[result]||'按步骤完成接入；保存凭据需要验证面板登录密码。',!!result&&result!=='success')).catch(e=>message(e.message,true));
})();
