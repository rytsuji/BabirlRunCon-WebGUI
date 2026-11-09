import argparse
import asyncio
import copy
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
import uvicorn
import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import Field, field_validator, model_validator

from controllers import HttpController
from monitor_api import read_monitor
from manual_api import execute_manual
from models import Babimo, Experiment, ExperimentConfig, RunControlEndpoint, ServerConfig, Strict
from run_timer import RunTimers
from monitor import Monitor
from service import ControlService
from storage import Store, now

BUILD_ID = "v1-20261109-locks-22"
BASE = Path(__file__).resolve().parent


class ConfigEdit(Strict):
    yaml: str = Field(max_length=131072)
    revision: str
    comment: str = Field(default='', max_length=1000)
    allow_metadata_edit: bool = False


class NewExperiment(Experiment):
    id: str = Field(default_factory=lambda: 'exp_' + uuid4().hex,
                    pattern=r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')


class NewRunControlEndpoint(RunControlEndpoint):
    enable_nssta: bool = True


class NewExperimentConfig(ExperimentConfig):
    experiment: NewExperiment
    run_control_api: NewRunControlEndpoint
    babimo: Babimo = Field(default_factory=lambda: Babimo(babinfo=True, babild=True))


class HistoryComment(Strict):
    comment: str = Field(max_length=1000)


class DeleteConfigHistory(Strict):
    confirmation: int = Field(ge=1,strict=True)
    revision: str


class DeleteConfigHistoryBatch(Strict):
    ids: list[int] = Field(min_length=1, max_length=10000)
    revision: str

    @field_validator('ids', mode='before')
    @classmethod
    def validate_ids(cls, value):
        if not isinstance(value, list) or any(type(item) is not int or item < 1 for item in value):
            raise ValueError('History IDs must be positive integers')
        return list(dict.fromkeys(value))


class RunEdit(Strict):
    runname: str = Field(min_length=1, max_length=200)
    runnumber: int = Field(ge=0, le=2147483647, strict=True)

    @field_validator("runname")
    @classmethod
    def validate_name(cls, value):
        if any(c.isspace() for c in value) or "\x00" in value or len(value.encode()) > 79:
            raise ValueError("Run name must be one token of at most 79 UTF-8 bytes")
        return value


class RunTimerSpec(Strict):
    duration_sec: int = Field(ge=1, le=31536000, strict=True)
    repeat: bool = False
    total_runs: int = Field(default=1, ge=1, le=1000000, strict=True)


class RunTimerComments(Strict):
    id: str
    header: Optional[str] = None
    ender: Optional[str] = None

    @model_validator(mode='after')
    def validate_comments(self):
        if self.header is None and self.ender is None:
            raise ValueError('Enter Header or Ender')
        for value in (self.header, self.ender):
            if value is not None and ('\x00' in value or len(value.encode('utf-8')) > 79):
                raise ValueError('Header and Ender accept at most 79 UTF-8 bytes without NUL')
        return self


class ActionRequest(Strict):
    action: Literal["start", "stop", "nssta", "restart"]
    header: str = Field(default="", max_length=4000)
    ender: str = Field(default="", max_length=4000)
    force_restart: bool = False
    timer: Optional[RunTimerSpec] = None

    @model_validator(mode="after")
    def validate_header(self):
        if self.timer is not None and self.action not in ('start', 'nssta'):
            raise ValueError('A timer can only be armed with Start or NSSTA')
        if self.action in ("start", "nssta") and ("\x00" in self.header or len(self.header.encode()) > 79):
            raise ValueError("Header must contain at most 79 UTF-8 bytes without NUL; blank preserves the current header")
        if (self.action == 'stop' or self.timer is not None) and ('\x00' in self.ender or len(self.ender.encode('utf-8'))>79):
            raise ValueError('Ender must contain at most 79 UTF-8 bytes without NUL')
        return self


class ConfigText(Strict):
    yaml: str = Field(max_length=131072)


class WebutilWrite(Strict):
    kind: Literal['eflist','hdlist','ssm','es']
    payload: dict
    efn: Optional[int] = Field(default=None,ge=0,le=255)


class DeleteExperiment(Strict):
    confirmation: str
    revision: str


class ManualRequest(Strict):
    revision: str
    arguments: dict[str,str] = Field(default_factory=dict,max_length=32)

    @field_validator('arguments')
    @classmethod
    def bounded_arguments(cls, value):
        if any(len(key)>64 or len(text)>65536 for key,text in value.items()):
            raise ValueError('API argument is too long')
        return value


class ProcessAction(Strict):
    process: Literal['babinfo','babild','babissm','babian']
    action: Literal['start','stop']
    efn: int = Field(default=1,ge=0,le=255,strict=True)
    allow_unavailable: bool = False
    allow_running: bool = False


def create_app(settings=None, experiments_dir=None, controller=None, http_client=None, monitor_http_client=None):
    settings = settings or ServerConfig()
    store = Store(experiments_dir or BASE / settings.experiments_dir)
    client = http_client or httpx.AsyncClient(timeout=settings.request_timeout_sec, follow_redirects=False)
    monitor_client=monitor_http_client or httpx.AsyncClient(timeout=10,follow_redirects=False)
    adapter = controller or HttpController(client)
    service = ControlService(store, adapter, client, settings)
    monitor = Monitor(adapter)
    service.monitor = monitor
    run_timers = RunTimers(service, monitor)
    manual_tasks=set()

    @asynccontextmanager
    async def lifespan(app):
        store.recover_operations()
        yield
        for task in list(manual_tasks):task.cancel()
        await asyncio.gather(*manual_tasks,return_exceptions=True)
        await run_timers.close()
        await service.close()
        if http_client is None:
            await client.aclose()
        if monitor_http_client is None:
            await monitor_client.aclose()

    app = FastAPI(title="DAQ Run Control", lifespan=lifespan)
    app.state.store = store
    app.state.service = service
    app.state.run_timers = run_timers

    @app.middleware("http")
    async def same_origin(request: Request, call_next):
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            origin = request.headers.get("origin")
            if origin and urlsplit(origin).netloc != request.headers.get("host"):
                return JSONResponse({"detail": "Cross-origin changes are not allowed"}, status_code=403)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-DAQ-Build"] = BUILD_ID
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    def config_for(eid):
        try:
            return store.read_config(eid)
        except FileNotFoundError:
            raise HTTPException(404, "Experiment not found.")
        except (ValueError, yaml.YAMLError) as exc:
            raise HTTPException(422, str(exc))

    def owner_of_eb(eid, config):
        timer_owner = run_timers.owners.get(service.key(config))
        if timer_owner and timer_owner['experiment_id'] != eid:
            return timer_owner['experiment_id']
        for other in store.ids():
            if other == eid:
                continue
            other_config, _, _ = config_for(other)
            if service.key(other_config) == service.key(config) and store.active_run(other):
                return other
        return None

    @app.get("/api/info")
    async def info():
        return {"mode": settings.controller, "version": "1", "build_id": BUILD_ID}

    @app.post("/api/config/serialize")
    async def serialize_config(config: ExperimentConfig):
        return {"yaml": yaml.safe_dump(config.model_dump(exclude_none=True), allow_unicode=True, sort_keys=False)}

    @app.post("/api/config/parse")
    async def parse_config(text: ConfigText):
        try:
            return ExperimentConfig.model_validate(yaml.safe_load(text.yaml)).model_dump()
        except (ValueError, yaml.YAMLError) as exc:
            raise HTTPException(422, str(exc))

    @app.get("/api/experiments")
    async def experiments():
        result = []
        for eid in store.ids():
            try:
                config, _, _ = store.read_config(eid)
                result.append({**config.experiment.model_dump(), "eb": config.eb.model_dump(),
                               "active_operation": service.active.get(service.key(config))})
            except (ValueError, yaml.YAMLError) as exc:
                result.append({"id": eid, "name": eid, "error": str(exc)})
        return result

    @app.post("/api/experiments", status_code=201)
    async def create(config: NewExperimentConfig):
        try:
            store.create(config)
        except FileExistsError:
            raise HTTPException(409, "Experiment ID already exists.")
        return {"id": config.experiment.id}

    @app.get("/api/experiments/{eid}/config")
    async def get_config(eid: str):
        config, raw, revision = config_for(eid)
        return {"config": config.model_dump(), "yaml": raw, "revision": revision,
                "experiment_path":'/experiments/'+eid,"server_port":settings.port}

    @app.get('/api/experiments/{eid}/config-history')
    async def config_history(eid: str):
        _, raw, _ = config_for(eid)
        if not store.config_edits(eid) and not store.config_history_initialized(eid):
            store.record_config(eid, raw, 'import')
        return store.config_edits(eid)

    @app.patch('/api/experiments/{eid}/config-history/{edit_id}')
    async def history_comment(eid: str, edit_id: int, body: HistoryComment):
        config_for(eid)
        if not store.comment_config_edit(eid, edit_id, body.comment):
            raise HTTPException(404, 'Configuration revision not found.')
        return {'saved': True}

    @app.post('/api/experiments/{eid}/config-history/delete')
    async def delete_config_history_batch(eid: str, body: DeleteConfigHistoryBatch):
        _, _, revision = config_for(eid)
        if body.revision != revision:
            raise HTTPException(409, 'Reload the latest configuration before deleting history.')
        if not store.delete_config_edits(eid, body.ids):
            raise HTTPException(404, 'Configuration revision not found. Reload history.')
        return {'deleted': len(body.ids)}

    @app.delete('/api/experiments/{eid}/config-history/{edit_id}')
    async def delete_config_history(eid: str, edit_id: int, body: DeleteConfigHistory):
        _,_,revision=config_for(eid)
        if body.confirmation!=edit_id or body.revision!=revision:
            raise HTTPException(409,'Confirm the history entry and reload the latest configuration.')
        if not store.delete_config_edit(eid,edit_id):
            raise HTTPException(404,'Configuration revision not found.')
        return {'deleted': True}

    @app.delete('/api/experiments/{eid}')
    async def delete_experiment(eid: str, body: DeleteExperiment):
        config, _, revision = config_for(eid)
        if body.confirmation != eid or body.revision != revision:
            raise HTTPException(409, 'Confirm the experiment ID and reload the latest configuration.')
        if service.key(config) in service.active or service.key(config) in run_timers.owners or store.active_run(eid):
            raise HTTPException(409, 'Resolve the active operation or unfinished Run first.')
        store.archive(eid)
        monitor.invalidate(eid)
        return {'deleted': True}

    @app.get('/api/experiments/{eid}/processes')
    async def processes(eid: str):
        config, _, _ = config_for(eid)
        try:
            return await adapter.processes(config)
        except Exception as exc:
            raise HTTPException(502, str(exc))

    @app.post('/api/experiments/{eid}/processes')
    async def process_action(eid: str, body: ProcessAction):
        config, _, _ = config_for(eid)
        if owner_of_eb(eid, config):
            raise HTTPException(409, 'This EB is controlled by another experiment.')
        if store.active_run(eid) and not body.allow_running and not (body.allow_unavailable and body.action == 'start'):
            raise HTTPException(409, 'Resolve the unfinished Run first.')
        if body.allow_running or body.allow_unavailable:
            await run_timers.cancel(eid, 'Timer cancelled by emergency process control.')
        op = service.reserve(config, eid, 'process-' + body.action)
        try:
            result = await service.step(eid, op, body.action + ' ' + body.process,
                                        lambda: adapter.processes(config, body.model_dump()))
            op.update(status='succeeded', message='Process action verified')
            return result
        except Exception as exc:
            op.update(status='failed', message=str(exc))
            raise HTTPException(409, str(exc))
        finally:
            op['finished_at'] = now()
            service.persist(eid, op)
            service.active.pop(service.key(config), None)
            monitor.invalidate(eid)

    @app.put("/api/experiments/{eid}/config")
    async def save_config(eid: str, edit: ConfigEdit):
        config, _, _ = config_for(eid)
        try:
            proposed = ExperimentConfig.model_validate(yaml.safe_load(edit.yaml))
        except (ValueError, yaml.YAMLError) as exc:
            raise HTTPException(422, str(exc))
        if not edit.allow_metadata_edit and (proposed.experiment.id != config.experiment.id or
                                              proposed.experiment.name != config.experiment.name or
                                              proposed.experiment.description != config.experiment.description):
            raise HTTPException(409, 'Unlock Experiment details before changing the URL path, Name or Description.')
        old_key, new_key = service.key(config), service.key(proposed)
        if new_key != old_key and new_key in service.active:
            raise HTTPException(409, "The destination EB has an active operation.")
        if owner_of_eb(eid, config) or owner_of_eb(eid, proposed):
            raise HTTPException(409, "This EB is owned by another active experiment.")
        op = service.reserve(config, eid, "config")
        saved_eid = eid
        # Save local configuration without contacting either the old or new target.
        if new_key != old_key:
            service.active[new_key] = op
        try:
            if store.active_run(eid):
                raise HTTPException(409, "Configuration cannot change while a Run is unresolved.")
            try:
                _, raw, revision = store.save_config(eid, edit.yaml, edit.revision, edit.comment)
                saved_eid = proposed.experiment.id
            except (ValueError, yaml.YAMLError) as exc:
                raise HTTPException(409, str(exc))
            op.update(status="succeeded", message="Configuration saved")
            return {"yaml": raw, "revision": revision, "experiment_id": saved_eid}
        except RuntimeError as exc:
            raise HTTPException(409, str(exc))
        finally:
            if op["status"] == "queued":
                op.update(status="failed", message="Configuration was not changed")
            op["finished_at"] = now()
            service.persist(saved_eid, op)
            monitor.invalidate(eid)
            service.active.pop(old_key, None)
            if new_key != old_key:
                service.active.pop(new_key, None)

    @app.get("/api/experiments/{eid}/status")
    async def status(eid: str, refresh: bool = False):
        config, _, config_revision = config_for(eid)
        active=service.active.get(service.key(config))
        if active and (active.get('wait_started_at') or active['action']=='restart'):
            observed=copy.deepcopy(monitor.cache.get(eid,{'state':{'state':'unknown'},'connected':False}))
            observed.pop('next_events',None)
            observed['es_connections']=monitor.es_connections.get(eid)
        else:
            observed = await monitor.read(eid, config, refresh)
        return {**observed,
                'config_revision':config_revision,
                "run_timer": run_timers.public(eid),
                "history_version": store.history_version(eid),
                "checked_at": now(), "active_operation": service.active.get(service.key(config)),
                "manual_api_pending":service.manual_active.get(service.key(config)),
                "active_run": bool(store.active_run(eid)), "eb_owner": owner_of_eb(eid, config),
                "control_errors":store.control_errors(eid),
                "stop_recovery":service.stop_recovery(eid,config),"restart_unlocked":service.restart_unlocked(eid,config),
                "mode": settings.controller}

    @app.get("/api/experiments/{eid}/history")
    async def history(eid: str, mode: Literal['all','saved','nssta']='all'):
        config_for(eid)
        try:
            return {"runs": [store.public_run(run) for run in store.runs(eid, mode=mode)], "recall": store.read_history(eid).model_dump(),
                    "operations": store.operations(eid)}
        except (ValueError, yaml.YAMLError) as exc:
            raise HTTPException(422, f"run_state.yaml: {exc}")

    @app.post("/api/experiments/{eid}/connections/refresh")
    @app.post("/api/experiments/{eid}/connections/connect")
    async def refresh_connections(eid: str,request:Request):
        config,_,_ = config_for(eid)
        if owner_of_eb(eid,config):
            raise HTTPException(409,"This EB is controlled by another experiment.")
        op = service.reserve(config,eid,"connections")
        try:
            explicit=request.url.path.endswith('/connect')
            if explicit:await service.check_state(eid,config,{'stopped'})
            result = await service.connections(eid,config,explicit)
            op["steps"] = [{"name":"ES connection readback","status":"succeeded","response":result}]
            op.update(status="succeeded",message="Connections checked")
            return result
        except Exception as exc:
            op.update(status="failed",message=str(exc))
            raise HTTPException(409 if explicit else 502,str(exc))
        finally:
            op["finished_at"] = now()
            service.persist(eid,op)
            service.active.pop(service.key(config),None)

    @app.get('/api/experiments/{eid}/webutil/{kind}')
    async def webutil_read(eid:str,kind:Literal['config','es','raw'],efn:Optional[int]=None,refresh:bool=False):
        config,_,_=config_for(eid)
        if kind=='es' and (efn is None or not 0<=efn<=255):
            raise HTTPException(422,'Select an ES number from 0 to 255')
        try:
            shared=monitor.arguments(eid,config)
            if kind=='config' and not refresh and shared.get('raw_config'):
                return shared['raw_config']
            raw=await adapter.webutil(eid,config,kind,efn=efn)
            if kind=='config' and hasattr(adapter,'decode_config'):
                state=adapter.decode_config(raw)
                state['target']=shared.get('target',{})
                monitor.publish(eid,config,state)
            return raw
        except Exception as exc:raise HTTPException(502,f'Webutil API: {exc}')

    @app.put('/api/experiments/{eid}/webutil')
    async def webutil_write(eid:str,body:WebutilWrite):
        config,_,_=config_for(eid)
        if body.kind=='es' and body.efn is None:raise HTTPException(422,'ES number is required')
        if owner_of_eb(eid,config):raise HTTPException(409,'This EB is controlled by another experiment')
        op=service.reserve(config,eid,'webutil-'+body.kind)
        try:
            await service.check_state(eid,config,{'stopped'})
            if store.active_run(eid):raise RuntimeError('Resolve the unfinished Run before editing DAQ settings')
            result=await service.step(eid,op,'Set '+body.kind,lambda:adapter.webutil(eid,config,body.kind,body.payload,body.efn))
            if isinstance(result.get('after'),dict) and result['after'].get('runinfo') and hasattr(adapter,'decode_config'):
                shared=monitor.arguments(eid,config)
                verified=adapter.decode_config(result['after'])
                verified['target']=shared.get('target',{})
                monitor.publish(eid,config,verified)
            op.update(status='succeeded',message='Settings verified')
            return result
        except Exception as exc:
            op.update(status='failed',message=str(exc))
            raise HTTPException(409,str(exc))
        finally:
            op['finished_at']=now();service.persist(eid,op)
            monitor.invalidate(eid);service.active.pop(service.key(config),None)

    @app.post("/api/experiments/{eid}/run-config")
    async def configure_run(eid: str, edit: RunEdit):
        config, _, _ = config_for(eid)
        if owner_of_eb(eid, config):
            raise HTTPException(409, "This EB is owned by another active experiment.")
        op = service.reserve(config, eid, "run-config")
        try:
            await service.check_state(eid, config, {"stopped"})
            if store.active_run(eid):
                raise RuntimeError("An unresolved Run exists. Reconcile it first.")
            await service.step(eid, op, "Apply Run settings to DAQ",
                               lambda: adapter.configure(eid, config, edit.runname, edit.runnumber))
            state = await adapter.status(eid, config)
            monitor.publish(eid,config,state)
            if state["runname"] != edit.runname or state["runnumber"] != edit.runnumber:
                raise RuntimeError("DAQ readback does not match the requested values.")
            store.remember(eid, state)
            op.update(status="succeeded", message="Run settings applied")
            return state
        except Exception as exc:
            op.update(status="failed", message=str(exc))
            raise HTTPException(409, str(exc))
        finally:
            op["finished_at"] = now()
            service.persist(eid, op)
            monitor.invalidate(eid)
            service.active.pop(service.key(config), None)

    @app.post("/api/experiments/{eid}/actions", status_code=202)
    async def action(eid: str, request: ActionRequest):
        return await submit_action(eid, request)

    @app.post('/api/experiments/{eid}/timer/finish')
    async def finish_timer(eid: str):
        config_for(eid)
        return run_timers.finish(eid)

    @app.patch('/api/experiments/{eid}/timer/comments')
    async def update_timer_comments(eid: str, body: RunTimerComments):
        config_for(eid)
        return run_timers.update_comments(eid, body.id, body.header, body.ender)

    async def submit_action(eid, request, automatic=False):
        config, _, _ = config_for(eid)
        if service.key(config) in service.manual_active:
            raise HTTPException(409,'Waiting for a manual API response. Run controls are locked until completion or timeout.')
        if owner_of_eb(eid, config):
            raise HTTPException(409, "This EB is owned by another active experiment.")
        if not automatic and request.action in ('start', 'nssta') and service.key(config) in run_timers.owners:
            raise HTTPException(409, 'A Run timer is already active on this EB.')
        if not automatic and request.action in ('stop', 'restart'):
            await run_timers.cancel(eid)
        if request.action == "nssta" and not config.run_control_api.enable_nssta:
            raise HTTPException(403, "NSSTA is disabled for this experiment.")
        if request.action == "restart" and not any(h.enabled for h in config.restart_api) and not config.babimo.selected():
            raise HTTPException(409, "No Restart API is configured.")
        if request.action in ("start", "nssta") and store.active_run(eid):
            raise HTTPException(409, "An unresolved Run exists. Use Stop or Restart DAQ to recover.")
        if request.action in ('start','nssta') and store.control_errors(eid):
            raise HTTPException(409, 'Resolve the retained DAQ errors with Stop or Restart DAQ before starting.')
        recovery=service.stop_recovery(eid,config) if request.force_restart else None
        if request.force_restart and (request.action!='restart' or not service.restart_unlocked(eid,config)):
            raise HTTPException(409,'Emergency restart requires a Stop attempt with errors remaining after the configured Restart enable delay.')
        if request.action=='stop':await service.interrupt_start_for_stop(config)
        if request.action=='restart' and recovery and recovery.get('timeout_recovery'):
            previous=service.active.get(service.key(config))
            if previous:
                task=service.task_by_op.get(previous['id'])
                if task:
                    previous['cancel_reason']='Wait interrupted by manual Restart DAQ.'
                    task.cancel()
                    await asyncio.gather(task,return_exceptions=True)
        op = service.reserve(config, eid, request.action)
        op['force_restart']=request.force_restart
        if request.action=='stop':op['ender']=request.ender
        op['timeout_recovery']=bool(recovery and recovery.get('timeout_recovery'))
        if op['timeout_recovery']:op['recovery_timeout_sec']=recovery['minimum_stop_age_sec']
        try:
            if request.action=='restart':
                await service.check_restart(eid,config,request.force_restart)
            elif request.action!='stop':
                await service.check_state(eid, config,
                                          {"running", "nssta"} if request.action == "stop" else {"stopped"})
        except asyncio.CancelledError:
            if service.active.get(service.key(config)) is op:
                service.active.pop(service.key(config), None)
            op.update(status="failed", message="Operation cancelled before sending a DAQ command.", finished_at=now())
            service.persist(eid, op)
            monitor.invalidate(eid)
            raise
        except Exception as exc:
            service.active.pop(service.key(config), None)
            op.update(status="failed", message=str(exc), finished_at=now())
            service.persist(eid, op)
            monitor.invalidate(eid)
            if request.action in ('start','nssta'):
                store.retain_control_error(eid,op,str(exc))
            raise HTTPException(409, str(exc))
        if request.action=='restart':
            # Restart starts a new recovery attempt; prior errors cannot survive it.
            store.clear_control_errors(eid)
            monitor.reset_recovery(eid)
        initial = copy.deepcopy(op)
        if request.timer is not None:
            run_timers.begin(eid, config, request.timer, request.action, request.header, request.ender, op)
        service.start_task(eid, config, op, request.header)
        return op if automatic else initial

    async def timer_submit(eid, action, header, ender):
        return await submit_action(eid, ActionRequest(action=action, header=header, ender=ender), automatic=True)

    run_timers.submit = timer_submit

    @app.get('/api/experiments/{eid}/stop-recovery')
    async def stop_recovery(eid:str):
        config,_,_=config_for(eid)
        return {'stop_recovery':service.stop_recovery(eid,config),'restart_unlocked':service.restart_unlocked(eid,config)}

    @app.get('/api/experiments/{eid}/monitors/{index}')
    async def monitor_read(eid:str,index:int,revision:str,request:Request):
        config,_,current_revision=config_for(eid)
        if revision!=current_revision:raise HTTPException(409,'Monitor configuration changed')
        if not 0<=index<len(config.monitor_api):raise HTTPException(404,'Monitor not found')
        endpoint=config.monitor_api[index]
        if not endpoint.enabled:raise HTTPException(409,'Monitor is disabled')
        try:result=await read_monitor(monitor_client,endpoint,request,
                                     state=monitor.arguments(eid,config),store=store,eid=eid)
        except asyncio.CancelledError:
            return JSONResponse({'status':'fail','message':'Monitor request cancelled'},status_code=499)
        if config_for(eid)[2]!=revision:raise HTTPException(409,'Monitor configuration changed')
        return {**result,'revision':revision}

    @app.post('/api/experiments/{eid}/manual/{index}')
    async def manual_execute(eid:str,index:int,payload:ManualRequest,request:Request):
        config,_,revision=config_for(eid)
        if payload.revision!=revision:raise HTTPException(409,'Configuration changed. Reload the page.')
        if not 0<=index<len(config.manual_api):raise HTTPException(404,'API not found')
        endpoint=config.manual_api[index]
        if not endpoint.enabled:raise HTTPException(409,'API is disabled')
        custom={item.name for item in endpoint.query_params if item.source=='custom'} if endpoint.send_query_params else set()
        if set(payload.arguments)-custom:raise HTTPException(422,'Unknown custom argument')
        key=service.key(config)
        restricted='always' not in endpoint.timings
        token={'name':endpoint.name,'experiment_id':eid,'started_at':now()}
        if restricted:
            if key in service.active or key in service.manual_active:
                raise HTTPException(409,'Another DAQ operation or conditional API is in progress.')
            service.manual_active[key]=token

        async def run_manual():
            try:
                state=monitor.arguments(eid,config)
                if restricted:
                    try:
                        live=await getattr(adapter,'snapshot',adapter.status)(eid,config)
                        monitor.publish(eid,config,live)
                        state=monitor.arguments(eid,config)
                    except Exception as exc:return {'success':False,'error':str(exc),'checked_at':now()}
                if restricted:
                    phase='running' if state.get('state') in ('running','nssta') else 'idle' if state.get('state')=='stopped' else 'unknown'
                    if phase not in endpoint.timings:raise HTTPException(409,'API is not available in the current DAQ state')
                result=await execute_manual(monitor_client,endpoint,payload.arguments,request,state,store,eid,watch_disconnect=not restricted)
                if config_for(eid)[2]!=revision:raise HTTPException(409,'Configuration changed. Response discarded.')
                return result
            finally:
                if restricted and service.manual_active.get(key) is token:
                    service.manual_active.pop(key,None)

        async def bounded_manual():
            try:return await asyncio.wait_for(run_manual(),endpoint.timeout_sec)
            except asyncio.TimeoutError:return {'success':False,'error':f'Timed out after {endpoint.timeout_sec:g} seconds','checked_at':now()}

        task=asyncio.create_task(bounded_manual())
        manual_tasks.add(task)
        def finished(done):
            manual_tasks.discard(done)
            if restricted and service.manual_active.get(key) is token:service.manual_active.pop(key,None)
            if not done.cancelled():done.exception()
        task.add_done_callback(finished)
        try:
            # Keep the remote request and its lock alive through navigation/disconnect.
            return await asyncio.shield(task) if restricted else await task
        except asyncio.CancelledError:
            return JSONResponse({'success':False,'error':'Request cancelled'},status_code=499)

    app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")

    @app.get("/")
    @app.get("/experiments/{eid}")
    @app.get("/experiments/{eid}/edit")
    async def page(eid: Optional[str] = None):
        return FileResponse(BASE / "static/index.html")

    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=BASE / "server.yaml")
    args = parser.parse_args()
    try:
        path = args.config.resolve()
        settings = ServerConfig.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, yaml.YAMLError) as exc:
        parser.error(str(exc))
    uvicorn.run(create_app(settings, path.parent / settings.experiments_dir),
                host=settings.host, port=settings.port, workers=1)


if __name__ == "__main__":
    main()
