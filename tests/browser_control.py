"""Synthetic control interactions: no Tesla requests and no real vehicle commands."""
import json, mimetypes, os, time
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
from browser_smoke import BASE, ROOT

with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path=os.environ.get('BROWSER_EXECUTABLE') or None)
    for role in ['admin','viewer']:
        for width in [320,390,1440]:
            ctx=browser.new_context(viewport={'width':width,'height':900});page=ctx.new_page();errors=[];commands=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            state={'configured':True,'ever_configured':True,'role':role,'states':{'locked':True,'sentry':True,'frunk_open':True,'trunk_open':False,'charge_port':False,'windows_open':False,'climate_on':True,'climate_temp':22,'inside_temp':25,'charging':False,'cable':True,'charge_limit':80,'reported_at':int(time.time()*1000),'source':'fleet'},'nap':{}}
            def route(r):
                path=urlsplit(r.request.url).path
                if path.startswith('/api/'):
                    key=path[5:]
                    if key=='control/status':return r.fulfill(json=state)
                    if r.request.method=='POST':
                        commands.append((key,r.request.post_data_json))
                        if role=='viewer':return r.fulfill(status=403,json={'detail':'只读'})
                        if key=='control/refresh':return r.fulfill(json={'ok':True,'states':state['states']})
                        if key=='control/nap/start':state['nap']={'phase':'active','ends_at':time.time()+1800,'minutes':30}
                        if key=='control/nap/stop':state['nap']={'phase':'completed','ends_at':time.time()}
                        return r.fulfill(json=state['nap'] if '/nap/' in key else {'ok':True})
                    value=dict(BASE.get(key,{}))
                    if key in ['overview','account/status']:value['role']=role
                    return r.fulfill(json=value)
                f=ROOT/('index.html' if path=='/' else path.lstrip('/'))
                if not f.is_file():return r.fulfill(status=404)
                r.fulfill(body=f.read_bytes(),content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream')
            ctx.route('**/*',route)
            page.goto('http://teslahome.test/#control',wait_until='networkidle')
            assert page.locator('#page-control').is_visible()
            assert page.locator('#ctl-model-temp').text_content()=='22.0°C'
            assert '前备箱·开' in page.locator('[data-zone="frunk"]').text_content()
            assert page.locator('.ctl-module').count()==4
            assert not page.locator('#ctl-setup').is_visible()
            page.on('dialog',lambda d:d.accept())
            for name in ['climate','charge','lights','nap']:
                page.locator('[data-panel="'+name+'"]').click()
                assert page.locator('#ctl-dialog').is_visible()
                box=page.locator('#ctl-dialog').bounding_box();assert box['x']>=0 and box['x']+box['width']<=width
                if name=='climate':
                    if role=='admin':
                        page.locator('#ctl-temp-input').fill('23.5')
                        page.get_by_role('button',name='设置温度',exact=True).click()
                        page.wait_for_function("document.querySelector('#ctl-dialog-message').textContent.includes('指令已接受')")
                    else:assert page.get_by_role('button',name='设置温度',exact=True).is_disabled()
                if name=='nap' and role=='admin':
                    page.locator('#ctl-nap-start').click()
                    page.wait_for_function("document.querySelector('#ctl-nap-status').textContent.includes('剩余')")
                    page.locator('#ctl-nap-stop').click()
                    page.wait_for_function("document.querySelector('#ctl-nap-status').textContent==='已结束'")
                page.keyboard.press('Escape')
                assert not page.locator('#ctl-dialog').is_visible()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            if role=='admin':
                assert ('control/command',{'cmd':'set_temps','args':{'driver_temp':23.5}}) in commands
                assert len(commands)==3
            else:assert not commands
            # No configuration: show one tidy link; a partially configured user returns via account settings.
            state.update(configured=False,ever_configured=False)
            page.reload(wait_until='networkidle')
            assert page.locator('#ctl-setup').is_visible()
            if role=='admin' and width==390:
                folder=Path(os.environ.get('TEMP','/tmp'))/'teslahome-control-screens';folder.mkdir(exist_ok=True)
                page.screenshot(path=str(folder/'mobile.png'),full_page=True)
                page.locator('[data-panel="nap"]').click();page.screenshot(path=str(folder/'nap.png'))
            page.goto('http://teslahome.test/account.html',wait_until='networkidle')
            assert page.locator('#control-settings-entry').is_visible()==(role=='admin')
            assert not errors,errors
            ctx.close();print('CONTROL_BROWSER',role,width,'passed',flush=True)
    browser.close()
