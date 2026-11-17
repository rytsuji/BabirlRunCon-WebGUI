"""Shared snapshots and rate-limited counters; no DAQ commands are replayed."""
import asyncio
import copy
import time
from storage import now


class Monitor:
    def __init__(self, adapter):
        self.adapter = adapter
        self.cache = {}
        self.locks = {}
        self.epoch = 0
        self.es_connections = {}
        self.next_idle_check = {}
        self.last_counters = {}
        self.last_states = {}
        self.on_state = None
        self.on_state_error = None
        self.on_counters = None

    @staticmethod
    def source(config):
        return (config.eb.host.strip().lower(),config.run_control_api.api,config.run_control_api.token_env)

    def arguments(self, eid, config):
        """The same last observed data used by Run overview, without a DAQ read."""
        saved=self.last_states.get(eid)
        if saved and saved['source']==self.source(config):
            state=copy.deepcopy(self.cache.get(eid,{}).get('state',saved['state']))
            if eid in self.cache and not self.cache[eid].get('connected'):state['state']='unknown'
            return state
        return {}

    def check_source(self, eid, config):
        saved=self.last_states.get(eid)
        if saved and saved['source']!=self.source(config):
            for data in (self.cache,self.last_states,self.last_counters,self.es_connections,self.next_idle_check):
                data.pop(eid,None)

    def publish(self, eid, config, state, preserve_counters=True, metadata=True):
        if state.get('runname') is None:return
        self.check_source(eid,config)
        state=copy.deepcopy(state)
        previous=self.arguments(eid,config)
        if all(previous.get(key)==state.get(key) for key in ('runname','runnumber','start_time')):
            for key in ('event_num','es_event_num'):
                if state.get(key) is None or (preserve_counters and key=='es_event_num' and not state.get(key)):
                    if previous.get(key) is not None:state[key]=previous[key]
        self.last_states[eid]={'source':self.source(config),'state':state}
        if metadata and self.on_state:
            self.on_state(eid,config,state,state.get('state_observed_at') or now())
        entry=self.cache.get(eid)
        if entry is not None and state.get('raw_config'):
            entry['state']=copy.deepcopy(state)
            if metadata:
                entry.update(snapshot_at=now(),connected=True,error=None,
                             eb_connection={'connected':True,'error':None})

    def invalidate(self, eid):
        self.cache.clear()  # Other experiment pages may share the same EB.
        self.epoch += 1

    def reset_recovery(self, eid):
        self.invalidate(eid)
        self.last_counters.pop(eid,None)
        self.last_states.pop(eid,None)
        self.es_connections.pop(eid,None)
        self.next_idle_check.pop(eid,None)

    async def read(self, eid, config, refresh=False, safe_events=False):
        async with self.locks.setdefault(eid, asyncio.Lock()):
            self.check_source(eid,config)
            epoch = self.epoch
            entry = self.cache.get(eid)
            if refresh or entry is None:
                entry = {"state": self.arguments(eid,config) or {"state": "unknown"}, "connected": False,
                         "error": None, "snapshot_at": None, "events_at": None,
                         "next_events": 0, "api_connection": {"connected": False, "error": None}}
                await self.snapshot(eid, config, entry)
                if epoch == self.epoch:
                    self.cache[eid] = entry
            if time.monotonic() >= entry["next_events"]:
                eb_sampled=False
                if not safe_events and not entry['connected'] and entry['events_at'] is not None:
                    await self.snapshot(eid,config,entry)
                try:
                    if hasattr(self.adapter, "events"):
                        reader=getattr(self.adapter,'monitor_events',self.adapter.events) if safe_events else self.adapter.events
                        counters = await reader(eid, config)
                        if counters.get('skipped'):
                            entry['next_events']=time.monotonic()+config.run_control_api.event_poll_interval_sec
                            result=copy.deepcopy(entry)
                            result.pop('next_events',None)
                            result['es_connections']=self.es_connections.get(eid)
                            return result
                        connected = counters.pop("eb_connected", True)
                    else:
                        live = await self.adapter.status(eid, config)
                        counters = {key: live[key] for key in ("event_num", "es_event_num", "acquisition_errors")}
                        connected = True
                    if epoch != self.epoch:
                        return {"state":{"state":"unknown"},"connected":False,"error":None,"es_connections":None}
                    errors=counters.get('acquisition_errors',{})
                    eb_sampled=counters.get('event_num') is not None and '/api/v1/run/events' not in errors
                    for key in ('event_num','es_event_num'):
                        path='/api/v1/run/events' + ('/es' if key=='es_event_num' else '')
                        if path not in errors and counters.get(key) is not None:
                            entry['state'][key]=copy.deepcopy(counters[key])
                        elif key=='es_event_num' and counters.get(key):
                            entry['state'].setdefault(key,{}).update(copy.deepcopy(counters[key]))
                    entry['state']['acquisition_errors']={
                        **{key:value for key,value in entry['state'].get('acquisition_errors',{}).items()
                           if key in ('target','state','configuration')},**errors}
                    if self.on_counters:self.on_counters(eid,config,counters,now())
                    self.publish(eid,config,entry['state'],preserve_counters=False,metadata=False)
                    self.last_counters[eid]={key:copy.deepcopy(entry['state'].get(key)) for key in ('runname','runnumber','start_time','event_num','es_event_num','acquisition_errors')}
                    entry["connected"] = connected and entry["connected"]
                    entry["error"] = None if entry["connected"] else "EB event read failed; waiting for recovery."
                    entry["eb_connection"] = {"connected":entry["connected"],"error":entry["error"]}
                    if not connected and not safe_events:
                        # A slow ES request may hold the API's counter lock.
                        # getconfig uses an independent EB-only read path.
                        await self.snapshot(eid,config,entry)
                except Exception as exc:
                    entry.update(connected=False, error=str(exc),
                                 eb_connection={"connected":False,"error":str(exc)})
                    if self.on_counters:self.on_counters(eid,config,{'acquisition_errors':{'/api/v1/run/events':str(exc),'/api/v1/run/events/es':str(exc)}},now())
                if eb_sampled:
                    entry["events_at"] = now()
                entry["next_events"] = time.monotonic() + config.run_control_api.event_poll_interval_sec
            result = copy.deepcopy(entry)
            if entry['state'].get('state')=='stopped' and entry['connected'] and time.monotonic()>=self.next_idle_check.get(eid,0):
                self.next_idle_check[eid]=time.monotonic()+2
                try:
                    reader=getattr(self.adapter,'monitor_connections',self.adapter.connections) if safe_events else self.adapter.connections
                    checked=await reader(eid,config,False,idle_only=True)
                    checked.setdefault('checked_at',now())
                    if checked.get('runstatus'):
                        entry['state']['state']={'IDLE':'stopped','START':'running','NSSTA':'nssta'}.get(checked['runstatus'],'unknown')
                        self.publish(eid,config,entry['state'],metadata=False)
                        entry['eb_connection']={'connected':True,'error':None}
                        entry['api_connection']={'connected':True,'error':None}
                    if not checked.get('skipped') and epoch == self.epoch:self.es_connections[eid]=checked
                    entry['connection_checked_at']=now()
                    result=copy.deepcopy(entry)
                except Exception as exc:
                    if epoch == self.epoch:
                        self.es_connections[eid]={'supported':True,'items':[],'error':str(exc),'checked_at':now()}
                        # This request checks ES connections. Its failure cannot
                        # invalidate the independent EB snapshot/counter read.
                        entry['connection_checked_at']=now()
                        if hasattr(self.adapter,'probe_api'):entry['api_connection']=await self.adapter.probe_api(config)
                        result=copy.deepcopy(entry)
            if epoch != self.epoch:
                return {"state":{"state":"unknown"},"connected":False,"error":None,"es_connections":None}
            result.pop("next_events", None)
            result["es_connections"] = self.es_connections.get(eid)
            if not result["connected"]:
                result["state"]["state"] = "unknown"
            return result

    async def snapshot(self, eid, config, entry):
        epoch=self.epoch
        try:
            reader = getattr(self.adapter, "snapshot", self.adapter.status)
            entry["state"] = await reader(eid, config)
            previous=self.last_counters.get(eid,{})
            if previous and all(previous.get(key)==entry['state'].get(key) for key in ('runname','runnumber','start_time')):
                for key in ('event_num','es_event_num'):
                    if previous.get(key) is not None:entry['state'][key]=copy.deepcopy(previous[key])
                counter_errors={key:value for key,value in (previous.get('acquisition_errors') or {}).items() if key!='target'}
                entry['state']['acquisition_errors']={**counter_errors,**entry['state'].get('acquisition_errors',{})}
            entry.update(connected=True, error=None, snapshot_at=entry['state'].get('state_observed_at') or now())
            if epoch==self.epoch:self.publish(eid,config,entry['state'])
        except Exception as exc:
            entry.update(connected=False, error=str(exc))
            if epoch==self.epoch and self.on_state_error:self.on_state_error(eid,config,str(exc))
        if hasattr(self.adapter, "probe_api"):
            entry["api_connection"] = await self.adapter.probe_api(config)
        else:
            entry["api_connection"] = {"connected": entry["connected"], "error": entry["error"]}
        entry["eb_connection"] = {"connected":entry["connected"],"error":entry["error"]}
        entry["connection_checked_at"] = now()
