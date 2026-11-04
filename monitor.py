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

    def invalidate(self, eid):
        self.cache.clear()  # Other experiment pages may share the same EB.
        self.epoch += 1

    def reset_recovery(self, eid):
        self.invalidate(eid)
        self.last_counters.pop(eid,None)
        self.es_connections.pop(eid,None)
        self.next_idle_check.pop(eid,None)

    async def read(self, eid, config, refresh=False):
        async with self.locks.setdefault(eid, asyncio.Lock()):
            epoch = self.epoch
            entry = self.cache.get(eid)
            if refresh or entry is None:
                entry = {"state": {"state": "unknown"}, "connected": False,
                         "error": None, "snapshot_at": None, "events_at": None,
                         "next_events": 0, "api_connection": {"connected": False, "error": None}}
                await self.snapshot(eid, config, entry)
                if epoch == self.epoch:
                    self.cache[eid] = entry
            if time.monotonic() >= entry["next_events"]:
                if not entry['connected'] and entry['events_at'] is not None:
                    await self.snapshot(eid,config,entry)
                try:
                    if hasattr(self.adapter, "events"):
                        counters = await self.adapter.events(eid, config)
                        connected = counters.pop("eb_connected", True)
                    else:
                        live = await self.adapter.status(eid, config)
                        counters = {key: live[key] for key in ("event_num", "es_event_num", "acquisition_errors")}
                        connected = True
                    if epoch != self.epoch:
                        return {"state":{"state":"unknown"},"connected":False,"error":None,"es_connections":None}
                    entry["state"].update(counters)
                    self.last_counters[eid]={key:copy.deepcopy(entry['state'].get(key)) for key in ('runname','runnumber','event_num','es_event_num','acquisition_errors')}
                    entry["connected"] = connected and entry["snapshot_at"] is not None
                    entry["error"] = None if entry["connected"] else "EB event read failed; waiting for recovery."
                except Exception as exc:
                    entry.update(connected=False, error=str(exc))
                    entry["state"].update(event_num=None, es_event_num={})
                entry["events_at"] = now()
                entry["next_events"] = time.monotonic() + config.run_control_api.event_poll_interval_sec
            result = copy.deepcopy(entry)
            if entry['state'].get('state')=='stopped' and entry['connected'] and time.monotonic()>=self.next_idle_check.get(eid,0):
                self.next_idle_check[eid]=time.monotonic()+2
                try:
                    await self.snapshot(eid,config,entry)
                    result=copy.deepcopy(entry)
                    checked=await self.adapter.connections(eid,config,False,idle_only=True)
                    if checked.get('skipped'):
                        entry['state']['state']={'START':'running','NSSTA':'nssta'}.get(checked.get('runstatus'),'unknown')
                        result['state']['state']=entry['state']['state']
                    elif epoch == self.epoch:self.es_connections[eid]=checked
                except Exception as exc:
                    if epoch == self.epoch:self.es_connections[eid]={'supported':True,'items':[],'error':str(exc)}
            if epoch != self.epoch:
                return {"state":{"state":"unknown"},"connected":False,"error":None,"es_connections":None}
            result.pop("next_events", None)
            result["es_connections"] = self.es_connections.get(eid)
            if not result["connected"]:
                result["state"]["state"] = "unknown"
            return result

    async def snapshot(self, eid, config, entry):
        try:
            reader = getattr(self.adapter, "snapshot", self.adapter.status)
            entry["state"] = await reader(eid, config)
            previous=self.last_counters.get(eid,{})
            if previous and all(previous.get(key)==entry['state'].get(key) for key in ('runname','runnumber')):
                for key in ('event_num','es_event_num'):
                    if previous.get(key) is not None:entry['state'][key]=copy.deepcopy(previous[key])
                counter_errors={key:value for key,value in (previous.get('acquisition_errors') or {}).items() if key!='target'}
                entry['state']['acquisition_errors']={**counter_errors,**entry['state'].get('acquisition_errors',{})}
            entry.update(connected=True, error=None, snapshot_at=now())
        except Exception as exc:
            entry.update(connected=False, error=str(exc), snapshot_at=None)
        if hasattr(self.adapter, "probe_api"):
            entry["api_connection"] = await self.adapter.probe_api(config)
        else:
            entry["api_connection"] = {"connected": entry["connected"], "error": entry["error"]}
        entry["eb_connection"] = {"connected":entry["connected"],"error":entry["error"]}
        entry["connection_checked_at"] = now()
