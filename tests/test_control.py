import time
import pytest
from fastapi import HTTPException
from test_security import client, store, login
from app import control, nap


def sample(mode="off"):
    ts=time.time()*1000
    return {"climate_state":{"timestamp":ts,"climate_keeper_mode":mode,"is_climate_on":mode!="off","driver_temp_setting":22,"inside_temp":25},"vehicle_state":{"timestamp":ts,"locked":True,"sentry_mode":False,"ft":1,"rt":0,"fd_window":0,"fp_window":0,"rd_window":0,"rp_window":0},"charge_state":{"timestamp":ts,"charging_state":"Disconnected","charge_port_door_open":False,"charge_limit_soc":80}}


@pytest.fixture
def timer(tmp_path):
    clock=[time.time()]
    calls=[]
    mode=["off"]
    def command(cmd,args,vin):
        calls.append((cmd,args,vin))
        mode[0]="camp" if args['climate_keeper_mode']==3 else "off"
        return {"ok":True}
    t=nap.NapTimer(tmp_path/'nap.json',lambda vin:sample(mode[0]),command,lambda:clock[0])
    return t,clock,calls,mode


def test_nap_survives_restart_and_pins_vehicle(timer):
    t,clock,calls,mode=timer
    t.start('synthetic-vin',5)
    assert t.public()['phase']=='active' and 'vin' not in t.public()
    restarted=nap.NapTimer(t.path,t.fetch,t.command,t.clock)
    restarted.tick();assert len(calls)==1
    clock[0]+=301;restarted.tick()
    assert restarted.public()['phase']=='completed'
    assert [x[1]['climate_keeper_mode'] for x in calls]==[3,0]
    assert all(x[2]=='synthetic-vin' for x in calls)
    restarted.tick();assert len(calls)==2


def test_nap_duplicate_and_external_mode(timer):
    t,clock,calls,mode=timer;t.start('synthetic-vin',5)
    with pytest.raises(HTTPException):t.start('another-vin',5)
    mode[0]='dog';clock[0]+=301;t.tick()
    assert len(calls)==1 and t.public()['phase']=='completed'


def test_nap_shutdown_failure_retries(timer):
    t,clock,calls,mode=timer;t.start('synthetic-vin',5)
    original=t.command
    t.command=lambda *a: {'ok':False}
    clock[0]+=301;t.tick()
    assert t.public()['phase']=='retrying'
    assert t.active()
    t.command=original;clock[0]+=301;t.tick()
    assert t.public()['phase']=='completed'


def test_nap_start_timeout_arms_cleanup(timer):
    t,clock,calls,mode=timer
    original=t.command
    def uncertain(*args):
        original(*args)
        raise TimeoutError('private upstream text')
    t.command=uncertain
    with pytest.raises(HTTPException) as e:t.start('synthetic-vin',5)
    assert 'private upstream text' not in e.value.detail
    assert t.public()['phase']=='retrying'
    t.command=original;t.tick()
    assert t.public()['phase']=='completed'
    assert [x[1]['climate_keeper_mode'] for x in calls]==[3,0]


def test_nap_does_not_override_existing_climate(timer):
    t,clock,calls,mode=timer
    for value in ['dog','camp','on',None]:
        mode[0]=value
        with pytest.raises(HTTPException):t.start('synthetic-vin',5)
    assert not calls


def test_nap_config_guard(timer,monkeypatch):
    t,*_=timer;monkeypatch.setattr(nap,'timer',t)
    t.start('synthetic-vin',5)
    with pytest.raises(HTTPException):nap.ensure_idle()
    t.stop();nap.ensure_idle()


def test_state_requires_fresh_explicit_values(monkeypatch):
    p=sample();result=control.normalize_vehicle(p)
    assert result['frunk_open'] is True and result['trunk_open'] is False
    assert result['locked'] is True and result['sentry'] is False
    assert result['climate_temp']==22 and result['charge_port'] is False
    p['vehicle_state']['timestamp']-=180000
    result=control.normalize_vehicle(p)
    assert result['frunk_open'] is None and result['locked'] is None
    monkeypatch.setattr(control,'_snapshot',{})
    monkeypatch.setattr(control,'_live_states',lambda:{})
    monkeypatch.setattr(control,'_optimistic',lambda:{'locked':True})
    assert control._states()['locked'] is None


def test_new_endpoints_block_viewer(client):
    login(client,'guest')
    for path in ['refresh','nap/start','nap/stop']:
        assert client.post('/api/control/'+path,json={'minutes':30}).status_code==403


def test_nap_duration_validation(client,monkeypatch,timer):
    monkeypatch.setattr(nap,'timer',timer[0]);login(client)
    for value in [0,181,2.5,True,'30']:
        assert client.post('/api/control/nap/start',json={'minutes':value}).status_code==422
    assert not timer[2]
