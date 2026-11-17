"""Shared DAQ reads and retained notification state. No acquisition commands."""
import asyncio
import copy
import logging
import os
import time
from datetime import datetime

from monitor import Monitor
from monitor_api import read_monitor
from storage import now

LOG=logging.getLogger(__name__)
EB_EVENTS='/api/v1/run/events'
ES_EVENTS=EB_EVENTS+'/es'
STATE_FIELDS=('state','runname','runnumber','start_time','event_num','es_event_num','acquisition_errors','ef_info')


def instant(value):
    return datetime.fromisoformat(value).timestamp() if value else 0


class BackgroundMonitor:
    def __init__(self,monitor,service,store,monitor_client):
        self.monitor,self.service,self.store,self.client=monitor,service,store,monitor_client
        self.held={}
        self.sources={}
        self.inflight={}
        self.connection_reads={}
        self.next_state={}
        self.intervals={}
        self.monitors={}
        self.tasks=set()
        self.runner=None
        self.closed=False
        monitor.on_state=self.state_read
        monitor.on_state_error=self.state_failed
        monitor.on_counters=self.counters_read

    def track(self,coroutine):
        task=asyncio.create_task(coroutine)
        self.tasks.add(task)
        def finished(done):
            self.tasks.discard(done)
            if not done.cancelled() and done.exception():
                LOG.warning('Background read failed: %s',done.exception())
        task.add_done_callback(finished)
        return task

    def entry(self,config):
        return self.held.setdefault(Monitor.source(config),{
            'observed_at':None,'connected':False,'error':None,
            'state':{'state':'unknown','runname':None,'runnumber':None,'start_time':None,
                     'event_num':None,'es_event_num':{},'acquisition_errors':{},'ef_info':[]},
            'timestamps':{'state_attempted_at':None,'configuration_at':None,
                          'eb_events_at':None,'es_events_at':None}})

    def state_read(self,eid,config,state,stamp,full=True):
        self.sources[eid]=Monitor.source(config)
        entry=self.entry(config)
        if instant(stamp)<instant(entry['observed_at']):return
        previous=entry['state']
        changed=state.get('start_time') and state.get('start_time')!=previous.get('start_time')
        if changed:
            previous.update(event_num=None,es_event_num={})
            entry['timestamps'].update(eb_events_at=None,es_events_at=None)
        for key in STATE_FIELDS:
            if key not in ('event_num','es_event_num','acquisition_errors') and key in state:
                previous[key]=copy.deepcopy(state[key])
        errors=previous['acquisition_errors']
        errors.pop('state',None)
        if full:
            errors={key:value for key,value in errors.items() if key in (EB_EVENTS,ES_EVENTS)}
            errors.update({key:value for key,value in state.get('acquisition_errors',{}).items()
                           if key not in (EB_EVENTS,ES_EVENTS,'state')})
            entry['timestamps']['configuration_at']=stamp
        previous['acquisition_errors']=errors
        entry.update(observed_at=stamp,connected=True,error=None)
        entry['timestamps']['state_attempted_at']=stamp
        self.next_state[Monitor.source(config)]=time.monotonic()+2
        if full and state.get('events_observed_at'):
            self.counters_read(eid,config,state,state['events_observed_at'])

    def state_failed(self,eid,config,error):
        entry=self.entry(config)
        entry.update(connected=False,error=error)
        entry['state']['acquisition_errors']['state']=error
        entry['timestamps']['state_attempted_at']=now()
        self.next_state[Monitor.source(config)]=time.monotonic()+2

    def counters_read(self,eid,config,counters,stamp):
        entry=self.entry(config)
        errors=counters.get('acquisition_errors',{})
        for key,path,clock in (('event_num',EB_EVENTS,'eb_events_at'),('es_event_num',ES_EVENTS,'es_events_at')):
            if path in errors:
                entry['state']['acquisition_errors'][path]=errors[path]
                if key=='es_event_num' and counters.get(key):
                    entry['state'][key].update(copy.deepcopy(counters[key]))
            elif counters.get(key) is not None and instant(stamp)>=instant(entry['timestamps'][clock]):
                entry['state'][key]=copy.deepcopy(counters[key])
                entry['state']['acquisition_errors'].pop(path,None)
                entry['timestamps'][clock]=stamp

    def snapshot(self,eid,config):
        # No bind, read, probe, reconnect, or timestamp generation here.
        result=copy.deepcopy(self.held.get(Monitor.source(config)) or {
            'observed_at':None,'connected':False,'error':None,
            'state':{'state':'unknown','runname':None,'runnumber':None,'start_time':None,
                     'event_num':None,'es_event_num':{},'acquisition_errors':{},'ef_info':[]},
            'timestamps':{'state_attempted_at':None,'configuration_at':None,'eb_events_at':None,'es_events_at':None}})
        result['monitoring_enabled']=config.background_monitoring
        result['latest_start_operation']=self.store.latest_start_operation(eid)
        # Only whitelisted fields are copied; never expose raw configuration/receipts.
        secrets=[os.environ.get(name) for name in (config.run_control_api.token_env,'BABIRL_API_TOKEN') if name]
        def redact(value):
            if isinstance(value,str):
                for secret in secrets:
                    if secret:value=value.replace(secret,'[redacted]')
            elif isinstance(value,dict):value={key:redact(item) for key,item in value.items()}
            elif isinstance(value,list):value=[redact(item) for item in value]
            return value
        return redact(result)

    def bind(self,eid,config):
        source=Monitor.source(config)
        self.monitor.check_source(eid,config)
        self.sources[eid]=source
        for other,key in list(self.sources.items()):
            if other==eid or key!=source:continue
            if other in self.monitor.cache:
                entry=self.monitor.cache[eid]=self.monitor.cache[other]
                self.monitor.last_states[eid]={'source':source,'state':copy.deepcopy(entry['state'])}
                self.monitor.last_counters[eid]={key:copy.deepcopy(entry['state'].get(key))
                    for key in ('runname','runnumber','start_time','event_num','es_event_num','acquisition_errors')}
            if other in self.monitor.next_idle_check:
                self.monitor.next_idle_check[eid]=max(self.monitor.next_idle_check.get(eid,0),self.monitor.next_idle_check[other])

    async def read(self,eid,config,refresh=False):
        source=Monitor.source(config)
        current=self.inflight.get(source)
        if current is None or current.done():
            current=self.track(self.read_shared(eid,config,refresh))
            self.inflight[source]=current
        result=await asyncio.shield(current)
        self.bind(eid,config)
        return copy.deepcopy(result)

    async def connection_read(self,config,callback):
        source=Monitor.source(config)
        task=self.connection_reads.get(source)
        if task is None or task.done():
            task=self.track(callback())
            self.connection_reads[source]=task
        return copy.deepcopy(await asyncio.shield(task))

    async def read_shared(self,eid,config,refresh):
        self.bind(eid,config)
        source=Monitor.source(config)
        active=self.service.active.get(self.service.key(config))
        enabled=source in self.intervals or config.background_monitoring
        if active:
            # No native event/config calls can queue behind Start/Stop/Restart.
            # The small independent state read is safe during Start/Stop waits.
            if enabled and active['action']!='restart':await self.light_state(eid,config,active=True)
            result=copy.deepcopy(self.monitor.cache.get(eid,{'state':{'state':'unknown'},'connected':False}))
            result.pop('next_events',None)
            result['es_connections']=self.monitor.es_connections.get(eid)
            return result
        if enabled and not refresh and eid in self.monitor.cache:await self.light_state(eid,config)
        interval=self.intervals.get(source,config.run_control_api.event_poll_interval_sec)
        effective=config.model_copy(deep=True)
        effective.run_control_api.event_poll_interval_sec=min(interval,config.run_control_api.event_poll_interval_sec)
        result=await self.monitor.read(eid,effective,refresh,safe_events=enabled)
        if enabled:
            retained=self.entry(config)
            checked=result.get('es_connections')
            if checked and not checked.get('skipped') and retained['state']['state']=='stopped' and instant(checked.get('checked_at'))>=instant(retained['timestamps']['configuration_at']):
                errors=[item['error'] for item in checked.get('items',[]) if item.get('error')]
                if checked.get('error'):errors.append(checked['error'])
                if errors:retained['state']['acquisition_errors']['connections']='; '.join(errors)
                else:retained['state']['acquisition_errors'].pop('connections',None)
            result['connected']=retained['connected']
            result['error']=retained['error']
            result['state']['acquisition_errors']=copy.deepcopy(retained['state']['acquisition_errors'])
            if not retained['connected']:result['state']['state']='unknown'
        return result

    async def light_state(self,eid,config,active=False):
        source=Monitor.source(config)
        if time.monotonic()<self.next_state.get(source,0):return
        self.next_state[source]=time.monotonic()+2
        reader=getattr(self.monitor.adapter,'run_state',None)
        if reader is None:return
        epoch=self.monitor.epoch
        try:
            partial=await reader(eid,config)
        except Exception as exc:
            if epoch==self.monitor.epoch:self.state_failed(eid,config,str(exc))
            return
        if epoch!=self.monitor.epoch:return
        cached=self.monitor.cache.get(eid)
        prior=cached['state'] if cached else self.entry(config)['state']
        changed=any(partial.get(key)!=prior.get(key) for key in ('start_time','runnumber'))
        self.state_read(eid,config,partial,partial.get('state_observed_at') or now(),full=False)
        if active:return
        if cached and changed:
            # New collection: read runname and low-frequency configuration once.
            await self.monitor.snapshot(eid,config,cached)
        elif cached:
            cached['state'].update(partial)
            cached.update(connected=True,error=None,eb_connection={'connected':True,'error':None})
            self.monitor.publish(eid,config,cached['state'],metadata=False)

    def monitor_key(self,eid,config,endpoint):
        history=any(arg.source=='current_run_json' for arg in endpoint.query_params)
        return (Monitor.source(config),eid if history else None,endpoint.model_dump_json())

    async def monitor_read(self,eid,config,index,request=None):
        endpoint=config.monitor_api[index]
        state=self.monitor.arguments(eid,config)
        phase='running' if state.get('state') in ('running','nssta') else 'idle' if state.get('state')=='stopped' else 'unknown'
        if not endpoint.enabled or endpoint.timing not in ('always',phase):
            return {'status':'waiting','data':None,'message':'Not scheduled in the current DAQ state','checked_at':None}
        key=self.monitor_key(eid,config,endpoint)
        slot=self.monitors.setdefault(key,{'task':None,'result':None,'next':0,'phase':None,'waiters':0})
        identity=(phase,state.get('start_time'))
        if slot['task'] is None or slot['task'].done():
            if time.monotonic()>=slot['next'] or identity!=slot['phase']:
                async def fetch():
                    started=time.monotonic()
                    result=await read_monitor(self.client,endpoint,state=state,store=self.store,eid=eid)
                    slot.update(result=result,next=started+endpoint.interval_sec,phase=identity)
                    return result
                slot['task']=self.track(fetch())
        task=slot['task']
        if task is None:return slot['result']
        slot['waiters']+=1
        async def disconnected():
            if request is None:await asyncio.Future()
            while not await request.is_disconnected():await asyncio.sleep(.1)
        watcher=asyncio.create_task(disconnected())
        waiter=asyncio.ensure_future(asyncio.shield(task))
        try:
            done,_=await asyncio.wait({waiter,watcher},return_when=asyncio.FIRST_COMPLETED)
            if watcher in done:raise asyncio.CancelledError()
            return copy.deepcopy(await waiter)
        finally:
            slot['waiters']-=1
            watcher.cancel()
            if not waiter.done():waiter.cancel()
            await asyncio.gather(watcher,waiter,return_exceptions=True)
            keep_running=config.background_monitoring or Monitor.source(config) in self.intervals
            if not slot['waiters'] and not keep_running and not task.done():task.cancel()

    def start(self):
        self.runner=asyncio.create_task(self.run())

    async def run(self):
        while not self.closed:
            groups={}
            monitors=[]
            valid_monitor_keys=set()
            for eid in self.store.ids():
                try:
                    config,_,_=self.store.read_config(eid)
                    valid_monitor_keys.update(self.monitor_key(eid,config,endpoint) for endpoint in config.monitor_api)
                    if not config.background_monitoring:continue
                    groups.setdefault(Monitor.source(config),[]).append((eid,config))
                    monitors.extend((eid,config,index) for index,endpoint in enumerate(config.monitor_api) if endpoint.enabled)
                except Exception:continue  # One unreadable experiment must not stop other workers.
            for key,slot in list(self.monitors.items()):
                if key not in valid_monitor_keys and (slot['task'] is None or slot['task'].done()):self.monitors.pop(key,None)
            self.intervals={key:min(c.run_control_api.event_poll_interval_sec for _,c in items) for key,items in groups.items()}
            for source,items in groups.items():
                if self.inflight.get(source) is None or self.inflight[source].done():
                    eid,config=items[0]
                    self.track(self.read(eid,config))
            for eid,config,index in monitors:
                endpoint=config.monitor_api[index]
                slot=self.monitors.get(self.monitor_key(eid,config,endpoint))
                if slot is None or slot['task'] is None or slot['task'].done():
                    self.track(self.monitor_read(eid,config,index))
            await asyncio.sleep(1)

    async def close(self):
        self.closed=True
        if self.runner:self.runner.cancel()
        for task in list(self.tasks):task.cancel()
        await asyncio.gather(*([self.runner] if self.runner else []),*list(self.tasks),return_exceptions=True)
