"""Synthetic onboarding UI regression; never contacts Tesla or sends vehicle commands."""
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]/"app/static"
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path=os.environ.get("BROWSER_EXECUTABLE") or None)
    for width in (320,390,1440):
        context=browser.new_context(viewport={"width":width,"height":900})
        page=context.new_page(); errors=[]; submitted=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        state={"origin":"https://panel.example.com","redirect_uri":"https://panel.example.com/auth/tesla/callback","client_id":"","region":"cn","secret_saved":False,"registered":False,"authorized":False,"paired":False,"public_key":True,"proxy_installed":True,"pair_url":"https://www.tesla.cn/_ak/panel.example.com"}
        def route(route):
            path=urlsplit(route.request.url).path
            if path.startswith('/api/fleet/'):
                action=path.rsplit('/',1)[-1]
                if action=='status':return route.fulfill(json=state)
                submitted.append(action)
                if action=='config':
                    body=route.request.post_data_json
                    assert body['client_secret']=='synthetic-secret'
                    state.update(secret_saved=True,client_id=body['client_id'])
                if action=='register':state['registered']=True
                if action=='paired':state['paired']=True
                return route.fulfill(json={"ok":True})
            source=ROOT/path.lstrip('/')
            route.fulfill(body=source.read_bytes(),content_type=mimetypes.guess_type(str(source))[0] or 'application/octet-stream')
        page.route('**/*',route)
        page.goto('https://panel.example.com/fleet.html')
        page.locator('#fleet-wizard').wait_for(state='visible')
        assert page.locator('#fleet-register').is_disabled()
        page.locator('#fleet-client').fill('synthetic-client')
        page.locator('#fleet-secret').fill('synthetic-secret')
        page.locator('#fleet-password').fill('synthetic-password')
        page.locator('#fleet-config button').click()
        page.wait_for_function("document.querySelector('#state-config').textContent==='已保存'")
        assert page.locator('#fleet-secret').input_value()==''
        assert page.locator('#fleet-password').input_value()==''
        page.locator('#fleet-register').click()
        page.wait_for_function("document.querySelector('#state-register').textContent==='已注册'")
        assert page.locator('#fleet-authorize').is_enabled()
        state['authorized']=True
        page.goto('https://panel.example.com/fleet.html?fleet=success')
        page.locator('#fleet-paired').click()
        page.wait_for_function("document.querySelector('#state-pair').textContent==='已由你确认'")
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        assert not errors,errors
        assert submitted==['config','register','paired']
        if width==390:
            folder=Path(os.environ.get('TEMP','/tmp'))/'teslahome-fleet-screens';folder.mkdir(exist_ok=True)
            page.screenshot(path=str(folder/'mobile.png'),full_page=True)
        context.close()
        print('FLEET_BROWSER',width,'passed')
    browser.close()
