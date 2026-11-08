import asyncio
import json
from datetime import datetime, timezone
from uuid import uuid4

import httpx

from fastapi import HTTPException

from controllers import RemoteAPIError, invoke_hook
from storage import now


class ControlService:
    def __init__(self, store, controller, client, settings):
        self.store = store
        self.controller = controller
        self.client = client
        self.settings = settings
        self.active = {}  # EB host -> operation; one backend process only.
        self.manual_active = {}  # Conditional manual API request -> Run controls locked.
        self.tasks = set()
        self.task_by_op = {}
        self.monitor = None

    def key(self, config):
        return config.eb.host.strip().lower()

    def reserve(self, config, eid, action):
        key = self.key(config)
        if key in self.manual_active:
            raise HTTPException(409, "Waiting for a manual API response. Run controls are locked until completion or timeout.")
        if key in self.active:
            raise HTTPException(409, "Another operation is in progress on this EB.")
        op = {"id": uuid4().hex, "experiment_id": eid, "action": action,
              "status": "queued", "message": "Operation accepted", "created_at": now(),
              "finished_at": None, "steps": [], "config_snapshot": config.model_dump()}
        self.active[key] = op
        try:
            self.store.put_operation(eid, op)
        except BaseException:
            self.active.pop(key, None)
            raise
        return op

    async def check_state(self, eid, config, allowed):
        try:
            state = await self.controller.status(eid, config)
        except Exception as exc:
            raise RuntimeError(f"Unable to read DAQ state: {exc}") from exc
        if state["state"] not in allowed:
            raise RuntimeError(f"Operation is not allowed in state: {state['state']}")
        return state

    async def check_restart(self, eid, config, force=False):
        if force:return None
        if self.store.control_errors(eid):
            raise RuntimeError('Attempt Stop first. Restart becomes available after the configured delay if errors remain.')
        try:
            state = await self.controller.status(eid, config)
        except Exception:
            return None
        if state['state'] in ('running','nssta'):
            raise RuntimeError('Stop acquisition before restarting DAQ.')
        if state.get('target',{}).get('allow_writes') is False:
            raise RuntimeError('The Run Control API has writes disabled.')
        return state

    def stop_recovery(self, eid, config):
        for op in self.store.operations(eid, limit=100):
            if op['action'] not in ('stop','start','nssta','restart'):continue
            if op['action']=='restart' and op['status']=='failed' and not op['steps']:continue
            if op['action']=='stop' and op.get('wait_started_at') and not op.get('stop_confirmed'):
                if op.get('config_snapshot',{}).get('eb',{}).get('host','').strip().lower()!=self.key(config):return None
                clicked=datetime.fromisoformat(op['created_at'])
                current=datetime.now(timezone.utc)
                elapsed=(current-clicked).total_seconds()
                delay=op.get('restart_enable_after_sec',config.run_control_api.restart_enable_after_sec)
                errors=self.store.control_errors(eid)
                has_error=bool(errors or op.get('stop_error') or op.get('wait_timed_out'))
                error_times=[datetime.fromisoformat(item['created_at']) for item in errors]
                if op.get('recovery_error_at'):error_times.append(datetime.fromisoformat(op['recovery_error_at']))
                error_at=max(clicked,min(error_times)) if error_times else None
                error_elapsed=max(0,(current-error_at).total_seconds()) if error_at else 0
                return {'stop_operation_id':op['id'],'eligible':has_error and error_at is not None and error_elapsed>=delay,
                        'wait_seconds':max(0,delay-error_elapsed),'timeout_recovery':True,
                        'error_started_at':error_at.isoformat() if error_at else None,'error_elapsed_seconds':error_elapsed,
                        'minimum_stop_age_sec':(error_at-clicked).total_seconds()+delay if error_at else delay,
                        'action':op['action'],'elapsed_seconds':(datetime.now(timezone.utc)-datetime.fromisoformat(op['created_at'])).total_seconds(),
                        'timeout_seconds':delay}
            return None
        return None

    def restart_unlocked(self, eid, config):
        recovery=self.stop_recovery(eid,config)
        return bool(recovery and recovery['eligible'])

    async def interrupt_start_for_stop(self, config):
        active=self.active.get(self.key(config))
        if active and active['action'] in ('start','nssta'):
            task=self.task_by_op.get(active['id'])
            if task:
                task.cancel()
                await asyncio.gather(task,return_exceptions=True)
                if self.active.get(self.key(config)) is active:
                    active.update(status='unknown',finished_at=now(),message='Start interrupted by Stop.')
                    self.persist(active['experiment_id'],active)
                    self.active.pop(self.key(config),None)

    def start_task(self, eid, config, op, header):
        task = asyncio.create_task(self.execute(eid, config, op, header))
        self.tasks.add(task)
        self.task_by_op[op["id"]]=task
        task.add_done_callback(lambda done:self.task_by_op.pop(op["id"],None))
        task.add_done_callback(self.tasks.discard)

    def persist(self, eid, op):
        self.store.put_operation(eid, op)

    async def connections(self, eid, config, reconnect=False):
        if not hasattr(self.controller,"connections"):
            return {"supported":False,"items":[],"all_on_connected":False}
        result = await self.controller.connections(eid,config,reconnect)
        if self.monitor:
            self.monitor.es_connections[eid] = result
        return result

    async def step(self, eid, op, name, callback):
        step = {"name": name, "status": "running", "started_at": now(),
                "finished_at": None, "response": None}
        op["steps"].append(step)
        op["message"] = name
        self.persist(eid, op)
        try:
            result = await callback()
            step.update(status="succeeded", response=result)
            return result
        except BaseException as exc:
            unknown = isinstance(exc, (asyncio.CancelledError, asyncio.TimeoutError, TimeoutError, httpx.TransportError)) or getattr(exc, "outcome_unknown", False)
            step.update(status="unknown" if unknown else "failed",
                        error=str(exc) or "Operation interrupted")
            if isinstance(exc, RemoteAPIError):
                step["response"] = exc.response
            if op['action'] in ('start','nssta','stop') and not self.is_timeout(exc) and not op.get('cancel_reason'):
                self.store.retain_control_error(eid,op,name+': '+step['error'])
            raise
        finally:
            step["finished_at"] = now()
            self.persist(eid, op)

    async def hooks(self, eid, config, op, hooks, nssta=False):
        for hook in hooks:
            if not hook.enabled:continue
            if nssta and not hook.run_on_nssta:
                continue

            async def invoke(hook=hook):
                step = op["steps"][-1]
                step["api"] = hook.api
                query_params={}
                if getattr(hook,'send_query_params',False) and hook.query_params:
                    state=await self.controller.status(eid,config)
                    for argument in hook.query_params:
                        if argument.source=='getconfig_json':value=state.get('raw_config')
                        elif argument.source=='run_history_json':value=[self.store.public_run(run) for run in self.store.runs(eid)]
                        elif argument.source=='current_run_json':
                            runs=self.store.runs(eid,limit=1)
                            value=self.store.public_run(runs[0]) if runs else None
                        else:value=state.get(argument.source)
                        if value is None:raise RuntimeError(f'DAQ value is unavailable: {argument.source}')
                        query_params[argument.name]=value if hook.argument_transport=='json' else json.dumps(value,ensure_ascii=False,separators=(',',':')) if isinstance(value,(dict,list)) else str(value)
                    step['json_body' if hook.argument_transport=='json' else 'query_params']=query_params
                    self.persist(eid,op)

                def progress(data):
                    step["response"] = data
                    self.persist(eid, op)

                return await invoke_hook(self.client, hook, self.settings.operation_timeout_sec,
                                         progress,query_params if getattr(hook,'argument_transport','query')=='query' else None,
                                         query_params if getattr(hook,'send_query_params',False) and hook.argument_transport=='json' else None)
            await self.step(eid, op, hook.name, invoke)

    async def wait_state(self, eid, config, allowed, include_events=True):
        reader=self.controller.status if include_events else getattr(self.controller,'snapshot',self.controller.status)
        async def wait():
            while True:
                try:
                    state = await reader(eid, config)
                    if state["state"] in allowed:
                        return state
                except Exception:
                    pass
                await asyncio.sleep(0.5)
        return await asyncio.wait_for(wait(), self.settings.operation_timeout_sec)

    @staticmethod
    def is_timeout(exc):
        return isinstance(exc,(asyncio.TimeoutError,httpx.TimeoutException)) or getattr(exc,'is_timeout',False)

    async def timed_operation(self,eid,config,op,callback,allowed):
        limit=config.run_control_api.stop_timeout if op['action']=='stop' else config.run_control_api.start_timeout
        op.update(wait_started_at=now(),wait_timeout_sec=limit)
        op['restart_enable_after_sec']=config.run_control_api.restart_enable_after_sec
        self.persist(eid,op)
        child=asyncio.create_task(callback())
        def record_timeout(message):
            op.update(wait_timed_out=True,message=message)
            self.store.retain_control_error(eid,op,message)
            self.persist(eid,op)
        try:
            done,_=await asyncio.wait({child},timeout=limit)
            if not done:
                record_timeout(f"{op['action'].upper()} timeout after {limit:g} seconds. Observing DAQ state without resending the command.")
            try:
                state=await child
            except Exception as exc:
                if not self.is_timeout(exc):raise
                record_timeout('API command timed out. Observing DAQ state without resending the command.')
                deadline=asyncio.get_running_loop().time()+self.settings.operation_timeout_sec
                while asyncio.get_running_loop().time()<deadline:
                    try:
                        state=await self.controller.status(eid,config)
                        if state['state'] in allowed and not state.get('acquisition_errors'):
                            if op['action']=='stop':
                                connections=await self.connections(eid,config,False)
                                if connections.get('error') or any(item.get('error') for item in connections.get('items',[])):
                                    await asyncio.sleep(1);continue
                            break
                    except Exception:pass
                    await asyncio.sleep(1)
                else:
                    raise TimeoutError('DAQ state could not be verified before the recovery observation deadline.')
            op['wait_completed']=True
            if op['action'] in ('start','nssta'):
                self.store.clear_control_error(eid,op['id'])
            self.persist(eid,op)
            return state
        finally:
            if not child.done():child.cancel()
            await asyncio.gather(child,return_exceptions=True)

    async def execute(self, eid, config, op, header):
        run = None
        action = op["action"]
        op["status"] = "running"
        self.persist(eid, op)
        try:
            if action in ("start", "nssta"):
                before = await self.check_state(eid, config, {"stopped"})
                run = {"runname": before["runname"],
                       "runnumber": before["runnumber"], "mode": action,
                       "status": "preparing", "header": header, "started_at": None,
                       "finished_at": None, "config_snapshot": config.model_dump(),
                       "daq_config": before["raw_config"], "event_num": before["event_num"],
                       "es_event_num": before["es_event_num"]}
                self.store.put_run(eid, run)
                await self.hooks(eid, config, op, config.start_api, action == "nssta")
                await self.check_state(eid, config, {"stopped"})
                await self.connections(eid,config,False)
                # From this point a lost response can mean DAQ actually started.
                run["status"] = "unknown"
                self.store.put_run(eid, run)
                async def send_start():
                    await self.step(eid, op, "DAQ NSSTA" if action == "nssta" else "DAQ Start",
                                    lambda: self.controller.start(eid, config, header, action == "nssta"))
                    return await self.step(eid, op, "Verify DAQ started",
                                           lambda:self.wait_state(eid,config,{'nssta' if action=='nssta' else 'running'}))
                state=await self.timed_operation(eid,config,op,send_start,{'nssta' if action=='nssta' else 'running'})
                run.update(status="running", runname=state["runname"], runnumber=state["runnumber"], header=state["header"],
                           started_at=state["start_time"], daq_config=state["raw_config"],
                           event_num=state["event_num"], es_event_num=state["es_event_num"])
                self.store.put_run(eid, run)
                self.store.remember(eid, state)
            elif action == "stop":
                run = self.store.active_run(eid)
                # Preserve already displayed errors without delaying Stop for a read.
                cached=self.monitor.cache.get(eid,{}) if self.monitor else {}
                for message in (cached.get('state',{}).get('acquisition_errors') or {}).values():
                    self.store.retain_control_error(eid,op,str(message))
                if self.store.control_errors(eid):op['recovery_error_at']=op['created_at']
                op['stop_attempt_at']=now()
                op['stop_confirmed']=False
                self.persist(eid,op)

                async def send_and_confirm():
                    # Always attempt Stop first; an unavailable snapshot must never block it.
                    try:
                        receipt=await self.step(eid,op,'DAQ Stop',lambda:self.controller.stop(eid,config,ender=op['ender']) if op.get('ender') else self.controller.stop(eid,config))
                        # A Stop receipt alone cannot confirm the live DAQ state.
                        op['stop_receipt_verified']=receipt.get('verified') is True
                        self.persist(eid,op)
                    except Exception as exc:
                        op['stop_error']=str(exc)
                        self.persist(eid,op)
                        raise
                    state=await self.step(eid,op,'Verify DAQ stopped',lambda:self.wait_state(eid,config,{'stopped'}))
                    async def verify_es():
                        errors=list(state.get('acquisition_errors',{}).values())
                        connections=await self.connections(eid,config,False)
                        errors.extend(item['error'] for item in connections.get('items',[]) if item.get('error'))
                        if connections.get('error'):errors.append(connections['error'])
                        if errors:raise RuntimeError('\n'.join(errors))
                    try:
                        await self.step(eid,op,'Verify ES after Stop',verify_es)
                    except Exception as exc:
                        op['stop_error']=str(exc)
                        self.persist(eid,op)
                        raise
                    return state

                state=await self.timed_operation(eid,config,op,send_and_confirm,{'stopped'})
                op['stop_confirmed']=True
                self.persist(eid,op)
                if run is None:
                    run={'runname':state['runname'],'runnumber':state['runnumber'],
                         'mode':'start','status':'running','header':state['header'],
                         'started_at':state['start_time'],'config_snapshot':config.model_dump(),
                         'externally_started':True}
                mode=run['mode']
                from models import ExperimentConfig
                run_config=ExperimentConfig.model_validate(run.get('config_snapshot') or config.model_dump())
                run.update(status="stopped", finished_at=state["stop_time"],
                           daq_config=state["raw_config"], event_num=state["event_num"], es_event_num=state["es_event_num"])
                self.store.put_run(eid, run)
                self.store.remember(eid, state)
                try:
                    await self.connections(eid,config,False)
                    await self.hooks(eid, run_config, op, run_config.stop_api, mode == "nssta")
                except BaseException:
                    run["status"] = "postprocess_failed"
                    self.store.put_run(eid, run)
                    raise
                run["status"] = "completed"
                self.store.put_run(eid, run)
            elif action == "restart":
                restart_errors=[]
                try:
                    await self.check_restart(eid, config,op.get('force_restart',False))
                    if config.babimo.selected() or op.get('force_restart'):
                        try:
                            await self.step(eid,op,'Restart selected babimo processes',lambda:self.controller.restart_daemons(eid,config,force_restart=op.get('force_restart',False),timeout_recovery=op.get('timeout_recovery',False),wait_timeout_sec=op.get('recovery_timeout_sec',30)))
                        except Exception as exc:
                            restart_errors.append(str(exc) or type(exc).__name__)
                    # Restart hooks are unconditional and do not carry run_on_nssta.
                    for hook in config.restart_api:
                        if not hook.enabled:continue
                        try:
                            await self.check_restart(eid, config,op.get('force_restart',False))
                            await self.hooks(eid, config, op, [hook])
                        except Exception as exc:
                            restart_errors.append(str(exc) or type(exc).__name__)
                except Exception as exc:
                    restart_errors.append(str(exc) or type(exc).__name__)
                await self.step(eid,op,'Wait 2 seconds before ES connect',lambda:asyncio.sleep(2))
                async def ensure_idle():
                    # Verify the EB independently of ES event reads; ES may still be down.
                    reader=getattr(self.controller,'snapshot',self.controller.status)
                    state=await reader(eid,config)
                    if state['state']=='stopped':return state
                    if state['state'] in ('running','nssta'):
                        await self.step(eid,op,'DAQ Stop after Restart',lambda:self.controller.stop(eid,config))
                    return await self.wait_state(eid,config,{'stopped'},include_events=False)
                try:
                    state=await self.step(eid,op,'Verify DAQ is IDLE after Restart',
                        lambda:asyncio.wait_for(ensure_idle(),max(10,config.run_control_api.stop_timeout)))
                    unfinished=self.store.active_run(eid)
                    if unfinished:
                        unfinished.update(status='interrupted',finished_at=now(),daq_config=state['raw_config'],
                            event_num=state['event_num'],es_event_num=state['es_event_num'],
                            reconciliation='DAQ restart verified IDLE. Unfinished Run interrupted; post-run APIs were not executed.')
                        self.store.put_run(eid,unfinished)
                    # DAQ recovery is complete even if a separate ES reconnect fails.
                    self.store.clear_control_errors(eid)
                except Exception as exc:
                    restart_errors.append(str(exc) or 'DAQ did not reach IDLE after Restart.')
                async def send_connect_after_restart():
                    result=await self.connections(eid,config,True)
                    errors=[item['error'] for item in result.get('items',[]) if item.get('error')]
                    if result.get('error'):errors.append(result['error'])
                    if errors:raise RuntimeError('\n'.join(errors))
                    return result
                try:
                    await self.step(eid,op,'esconnect ON / SCR / PAS',send_connect_after_restart)
                except Exception as exc:
                    restart_errors.append(str(exc) or type(exc).__name__)
                async def verify_after_restart():
                    result=await self.connections(eid,config,False)
                    failures=[item.get('error') or f"ES {item.get('efn','?')}: connect={item.get('connect')}"
                              for item in result.get('items',[]) if item.get('enabled') and (item.get('error') or item.get('connect')!=1)]
                    if result.get('error'):failures.append(result['error'])
                    if failures:raise RuntimeError('\n'.join(failures))
                    return result
                try:
                    await self.step(eid,op,'Check ES connections after Restart',verify_after_restart)
                except Exception as exc:
                    restart_errors.append(str(exc) or type(exc).__name__)
                if restart_errors:raise RuntimeError('\n'.join(restart_errors))
            op.update(status="succeeded", message="Completed")
            if action in ('stop','restart'):
                self.store.clear_control_errors(eid)
        except asyncio.CancelledError:
            op.update(status="unknown", message=op.get('cancel_reason',"Web backend stopped. Verify DAQ state before proceeding."))
            if run:
                run.update(status='unknown',error='Operation interrupted before completion; verify DAQ state.')
                self.store.put_run(eid,run)
            raise
        except Exception as exc:
            uncertain = isinstance(exc, (asyncio.TimeoutError, TimeoutError, httpx.TransportError)) or any(s["status"] == "unknown" for s in op["steps"])
            op.update(status="unknown" if uncertain else "failed", message=str(exc) or type(exc).__name__)
            if action=='stop' and isinstance(exc,asyncio.TimeoutError):
                op['message']='Stop could not be confirmed before the operation timeout.'
            if action in ('start','nssta','stop'):
                self.store.retain_control_error(eid,op,op['message'])
            if run:
                if run["status"] == "preparing":
                    run["status"] = "failed"
                run["error"] = op["message"]
                self.store.put_run(eid, run)
        finally:
            op["finished_at"] = now()
            self.persist(eid, op)
            if self.active.get(self.key(config)) is op:
                self.active.pop(self.key(config), None)
            if self.monitor:
                self.monitor.invalidate(eid)

    async def close(self):
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
