"""Offline browser regression with synthetic telemetry only.
Set BROWSER_EXECUTABLE to an installed Chromium/Edge, or install Playwright Chromium.
"""
import json
import mimetypes
import os
import time
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1] / "app/static"
NOW = int(time.time() * 1000)
XSS = '<img src="data:image/png;base64,invalid" onerror="window.__auditXss=true">'
CAR = {"id":1,"name":"合成测试车辆","model":"Y","trim_badging":"long_range","efficiency":0.15}
BASE = {
 "overview": {"role":"admin","car_id":1,"cars":[CAR],"state":"offline","software_version":"test",
   "latest":{"date_ts":NOW-18*3600000,"usable_battery_level":75,"battery_level":75,"rated_battery_range_km":400,"ideal_battery_range_km":400,"odometer":10000,"inside_temp":24,"outside_temp":20},
   "kwh_per_ideal_km":0.15,"kwh_per_pct":0.75,"totals":{"drives_total":3,"month_km":300,"week_km":100,"year_km":2000,"month_energy_kwh":45},"charging":{"sessions":2,"energy_kwh":40,"cost":30,"duration_min":60}},
 "drives/daily":{"days_rows":[{"day":"2026-09-01","distance":30,"drives":2}]},
 "charging/summary":{"totals":{},"sessions":[]},
 "routes":{"routes":[{"id":1,"start_date_ts":NOW-3600000,"end_date_ts":NOW,"distance":10,"duration_min":30,"start_name":XSS,"end_name":"合成终点","points":[[0,0],[0.01,0.01]]}]},
 "activity":{"days":7,"battery":[[NOW-3600000,80],[NOW,75]],"drives":[],"charges":[],"sentry":[],"idle":[],"kwh_per_pct":0.75},
 "efficiency/trend":{"points":[{"start_ts":NOW-3600000,"eff_wh_km":145,"distance":10,"duration_min":30,"start_name":XSS,"end_name":"合成终点"}]},
 "tpms/trend":{"wheels":{w:[[NOW-3600000,2.9],[NOW,2.9]] for w in ['fl','fr','rl','rr']}},
 "system":{"disk_pct":20,"mem_pct":30},
 "battery/health":{"health_pct":98,"current_kwh":75,"nominal_kwh":76.5,"samples":8,"last_ts":NOW},
 "charging/sessions":{"charges":[]},"energy/cycles":{"cycles":[]},
 "temp/trend":{"inside":[[NOW-3600000,22],[NOW,24]],"outside":[[NOW-3600000,18],[NOW,20]]},
 "parking/fees":{"fees":[],"month_total":0,"total":0},"vehicle/delivery":{"date":"2026-01-01"},
 "control/status":{"configured":False,"states":{"locked":None,"climate_on":None,"charging":None,"cable":None}},
 "account/status":{"user":"owner","users":["owner","guest"],"role":"admin","roles":{"owner":"admin","guest":"viewer"},"tesla":{"authorized":True,"token_updated_ts":NOW},"cars":[dict(CAR,vin_tail="------")],"sync":{"positions":10,"drives":2,"charges":2,"last_data_ts":NOW},"steps":{"deployed":True,"authorized":True,"car_detected":True,"synced":True}}
}


def run():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=os.environ.get("BROWSER_EXECUTABLE") or None)
        for role in ["admin", "viewer"]:
            errors, writes = [], []
            failed = set()
            ctx = browser.new_context(viewport={"width":390,"height":844})
            def route_handler(route):
                path = urlsplit(route.request.url).path
                if path.startswith("/api/"):
                    key = path[5:]
                    if route.request.method not in ("GET", "HEAD"):
                        writes.append(key)
                        route.fulfill(status=403, json={"detail":"test blocks mutations"})
                    elif key in failed:
                        route.fulfill(status=503, json={"detail":"simulated unavailable"})
                    elif key.startswith("tiles/"):
                        route.fulfill(status=200,content_type="image/png",body=bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082'))
                    else:
                        data = dict(BASE.get(key, {}))
                        if key in ["overview","account/status"]:data['role']=role
                        route.fulfill(json=data)
                    return
                filename = "login.html" if path == "/login" else ("index.html" if path == "/" else path.lstrip("/"))
                source = (ROOT / filename).resolve()
                if not source.is_relative_to(ROOT) or not source.is_file():
                    route.fulfill(status=404);return
                route.fulfill(body=source.read_bytes(),content_type=mimetypes.guess_type(str(source))[0] or 'application/octet-stream',headers={"Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'"})
            ctx.route("**/*",route_handler)
            page=ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto('http://teslahome.test/',wait_until='networkidle')
            assert page.locator('#car-name').inner_text() == '合成测试车辆'
            assert page.locator('#state-text').inner_text() != '数据连接失败'
            assert float(page.locator('#reading-fl').evaluate("e=>getComputedStyle(e).fontSize.slice(0,-2)")) >= 14
            for width in [320,390,1440]:
                page.set_viewport_size({"width":width,"height":900})
                for tab in ['overview','charging','activity','vehicle','drives','control']:
                    page.locator('.tab[data-page="'+tab+'"]').click();page.wait_for_timeout(80)
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (role,width,tab)
            page.set_viewport_size({"width":390,"height":844})
            page.locator('.tab[data-page="activity"]').click();page.evaluate('scrollTo(0,600)')
            page.locator('.tab[data-page="control"]').click();page.wait_for_timeout(100)
            assert page.evaluate('scrollY') == 0
            if role=='viewer':
                assert page.locator('#access-note').is_visible()
                assert page.locator('#ctl-charge-toggle').is_disabled()
            page.locator('.tab[data-page="activity"]').click()
            page.locator('#chart-efficiency').scroll_into_view_if_needed()
            page.evaluate("echarts.getInstanceByDom(document.getElementById('chart-efficiency')).dispatchAction({type:'showTip',seriesIndex:0,dataIndex:0})")
            page.wait_for_timeout(100)
            assert not page.evaluate('window.__auditXss===true')
            assert page.locator('[onerror]').count()==0
            page.goto('http://teslahome.test/account.html',wait_until='networkidle')
            assert page.locator('#teslamate-link').get_attribute('href')=='http://localhost:4000'
            assert page.locator('.acct-header h1').bounding_box()['height'] < 30
            assert page.locator('#account-admin').is_visible() == (role=='admin')
            assert page.locator('#backup-admin').is_visible() == (role=='admin')
            # Auxiliary endpoint failure must not blank healthy overview data.
            failed.add('parking/fees')
            page.goto('http://teslahome.test/',wait_until='networkidle')
            assert page.locator('#car-name').inner_text()=='合成测试车辆'
            assert page.locator('#state-text').inner_text()!='数据连接失败'
            assert '停车费' in page.locator('#load-warning').inner_text()
            assert not errors, errors
            assert not writes, writes
            page.evaluate("localStorage.setItem('ttv-theme','light')")
            page.reload(wait_until='networkidle')
            assert page.locator('html').get_attribute('data-theme')=='light'
            output=os.environ.get('BROWSER_SCREENSHOTS')
            if output and role=='admin':
                Path(output).mkdir(parents=True,exist_ok=True)
                page.locator('.tab[data-page="overview"]').click()
                page.screenshot(path=str(Path(output)/'synthetic-overview.png'),full_page=True)
            ctx.close()
            print(role, 'browser regression passed',flush=True)
        browser.close()


if __name__=='__main__':run()
