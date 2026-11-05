"""Adapters for the supplied babirl-runcon API."""
import asyncio
import os
from datetime import datetime,timezone
from urllib.parse import urlsplit

import httpx

from models import LiveState
from storage import now

def daq_time(run, name):
    value=run.get(name+'time')
    if isinstance(value,(int,float)):
        if value<=0:return None
        return datetime.fromtimestamp(value,timezone.utc).isoformat()
    value=run.get(name+'date')
    if not value:return None
    # Older APIs render zero Unix time as a local 01-Jan-70 date.
    for pattern in ('%d-%b-%y %H:%M:%S','%Y-%m-%dT%H:%M:%S%z'):
        try:
            parsed=datetime.strptime(str(value),pattern)
            return None if parsed.year<=1970 else parsed.isoformat()
        except ValueError:pass
    return value


class RemoteAPIError(RuntimeError):
    def __init__(self, status_code, response):
        self.response = response
        error = response.get("error", {}) if isinstance(response, dict) else {}
        self.outcome_unknown = isinstance(error, dict) and error.get("outcome") == "unknown"
        # An ES socket failure is a failed command, not a long-running command.
        # Exact legacy messages keep compatibility with older API installations.
        self.is_timeout = isinstance(error,dict) and (error.get('code')=='operation_timeout' or error.get('message') in (
            'command deadline exceeded','native transport failure: command deadline exceeded'))
        message = error.get('message') if isinstance(error,dict) else error
        super().__init__(str(message or f"Run Control API returned HTTP {status_code}: {response}"))


class HttpController:
    def __init__(self, client):
        self.client = client

    async def probe_api(self, config):
        # Health checks the API process, independently of babild connectivity.
        try:
            response = await self.client.get(config.run_control_api.api + "/api/v1/health",
                                             headers=auth_headers(config.run_control_api, "BABIRL_API_TOKEN"))
            response.raise_for_status()
            if response.json().get("status") != "ok":
                raise ValueError("API health response was not ok")
            return {"connected": True, "error": None}
        except Exception as exc:
            return {"connected": False, "error": str(exc)}

    async def request(self, config, method, path, payload=None):
        response = await self.client.request(method, config.run_control_api.api + path,
                                             json=payload, headers=auth_headers(config.run_control_api, "BABIRL_API_TOKEN"),
                                             timeout=None if method=='POST' and path in ('/api/v1/run/start','/api/v1/run/stop') else self.client.timeout)
        data = response.json()
        if not response.is_success:
            raise RemoteAPIError(response.status_code, data)
        if not isinstance(data, dict):
            raise ValueError("Run Control response must be an object")
        if not isinstance(data.get("data"), dict):
            raise ValueError("Run Control envelope requires a data object")
        if method != "GET" and data["data"].get("verified") is not True:
            raise RuntimeError("Run Control operation was not verified")
        return data["data"]

    async def snapshot(self, eid, config):
        raw = await self.request(config, "GET", "/api/v1/run/config")
        run = raw["runinfo"]
        # Missing/invalid mandatory fields must never become a default IDLE.
        state = {"state": {"IDLE": "stopped", "START": "running", "NSSTA": "nssta"}.get(run["runstatus"], "unknown"),
                 "runname": run["runname"], "runnumber": run["runnumber"], "header": run.get("header", ""),
                 "start_time": daq_time(run,'start'), "stop_time": daq_time(run,'stop'),
                 "hdlist": raw.get("hdlist", []), "ef_info": raw.get("eflist", []),
                 "raw_config": raw, "acquisition_errors": {}, "event_num": None,
                 "es_event_num": {}, "target": {}}

        try:
            target = await self.client.get(config.run_control_api.api + "/api/v1/target",
                                           headers=auth_headers(config.run_control_api, "BABIRL_API_TOKEN"))
            target.raise_for_status()
            state["target"] = target.json()
        except Exception as exc:
            state["acquisition_errors"]["target"] = str(exc)
        return LiveState.model_validate(state).model_dump()

    async def events(self, eid, config):
        result = {"event_num": None, "es_event_num": {}, "acquisition_errors": {}, "eb_connected": True}

        async def optional(path):
            try:
                return await self.request(config, "GET", path)
            except Exception as exc:
                result["acquisition_errors"][path] = str(exc)
                if path.endswith("/events"):
                    result["eb_connected"] = False
                return {}

        events, es = await asyncio.gather(optional("/api/v1/run/events"), optional("/api/v1/run/events/es"))
        result["event_num"] = events.get("eventbuiltnumber")
        result["es_event_num"] = {str(item["efn"]): item for item in es.get("lastevtn", [])}
        return result

    async def status(self, eid, config):
        state = await self.snapshot(eid, config)
        counters = await self.events(eid, config)
        state.update(event_num=counters["event_num"], es_event_num=counters["es_event_num"])
        state["acquisition_errors"].update(counters["acquisition_errors"])
        return LiveState.model_validate(state).model_dump()

    async def configure(self, eid, config, runname, runnumber):
        return await self.request(config, "PATCH", "/api/v1/run/config", {"runname": runname, "runnumber": runnumber})

    async def connections(self, eid, config, reconnect=False, idle_only=False):
        response = await self.client.request("POST" if reconnect else "GET",
            config.run_control_api.api + "/api/v1/run/connections" + ('/connect' if reconnect else ''),
            json={} if reconnect else None, params={'idle_only':'true'} if idle_only else None,
            headers=auth_headers(config.run_control_api,"BABIRL_API_TOKEN"))
        if response.status_code in (404,405):
            return {"supported":False,"all_on_connected":False,"checked_at":now(),"items":[],
                    "error":"Install the ES-connections API update to enable this check."}
        if not response.is_success:raise RemoteAPIError(response.status_code,response.json())
        data = response.json()["data"]
        data["supported"] = True
        data["checked_at"] = now()
        return data

    async def processes(self, config, payload=None):
        response = await self.client.request("POST" if payload else "GET",
            config.run_control_api.api + "/api/v1/webutil/processes", json=payload,
            headers=auth_headers(config.run_control_api, "BABIRL_API_TOKEN"), timeout=60)
        data = response.json()
        if not response.is_success:
            raise RemoteAPIError(response.status_code, data)
        result = data["data"]
        if payload and result.get("verified") is not True:
            raise RuntimeError("Process action was not verified")
        return result

    async def webutil(self,eid,config,kind,payload=None,efn=None):
        path='/api/v1/webutil/' + ('es/'+str(efn) if kind=='es' else kind)
        return await self.request(config,'GET' if payload is None else 'PUT',path,payload)

    async def restart_daemons(self,eid,config,force_restart=False,timeout_recovery=False,wait_timeout_sec=30):
        response=await self.client.post(config.run_control_api.api+'/api/v1/webutil/restart',
            json={'processes':list(dict.fromkeys(config.babimo.selected()+(['babinfo','babild'] if force_restart else []))),'efn':config.babimo.efn,'force_after_stop':force_restart and not timeout_recovery,
                  'force_after_timeout':timeout_recovery,'wait_timeout_sec':wait_timeout_sec},headers=auth_headers(config.run_control_api,'BABIRL_API_TOKEN'),timeout=120)
        data=response.json()
        if not response.is_success:raise RemoteAPIError(response.status_code,data)
        if data.get('data',{}).get('verified') is not True:raise RuntimeError('babimo restart was not verified')
        return data['data']

    async def start(self, eid, config, header, nssta=False):
        header_result = await self.request(config, "PATCH", "/api/v1/run/config", {"header": header}) if header else {"skipped": True, "reason": "Keep current header"}
        result = await self.request(config, "POST", "/api/v1/run/start", {"save": not nssta})
        return {"header_update": header_result, "start": result}

    async def stop(self, eid, config):
        return await self.request(config, "POST", "/api/v1/run/stop", {"ender": "completed"})


def auth_headers(endpoint, default_env=None):
    if not endpoint.enabled:
        raise RuntimeError('API is disabled in Edit configuration.')
    env_name = endpoint.token_env or default_env
    token = os.environ.get(env_name, "") if env_name else ""
    if endpoint.token_env and not token:
        raise RuntimeError(f"Token environment variable is not set: {endpoint.token_env}")
    return {"Authorization": "Bearer " + token} if token else {}


async def invoke_hook(client, hook, timeout, progress, query_params=None,json_body=None):
    headers = auth_headers(hook)
    url=httpx.URL(hook.api).copy_merge_params(query_params) if query_params else hook.api
    response = await client.post(url, headers=headers,json=json_body) if json_body is not None else await client.post(url, headers=headers)
    data = response.json()
    if not isinstance(data, dict):
        raise ValueError("API response must be an object")
    progress(data)  # Persist the receipt/job_id BEFORE waiting for completion.
    response.raise_for_status()
    if response.status_code == 202:
        job_id = data.get("job_id")
        if not isinstance(job_id, str) or not job_id or not job_id.isalnum():
            raise ValueError("202 response requires an alphanumeric job_id")
        origin = urlsplit(hook.api)
        # The daq-api delivered earlier exposes /api/jobs/{job_id}.
        poll_url = f"{origin.scheme}://{origin.netloc}/api/jobs/{job_id}"

        async def poll():
            nonlocal data
            while True:
                response = await client.get(poll_url, headers=headers)
                response.raise_for_status()
                data = response.json()
                if not isinstance(data, dict):
                    raise ValueError("Job response must be an object")
                progress(data)
                if data.get("status") in ("succeeded", "failed"):
                    return
                if data.get("status") not in ("queued", "running"):
                    raise ValueError("Unknown remote job status")
                await asyncio.sleep(0.5)

        await asyncio.wait_for(poll(), timeout)
    if data.get("status") != "succeeded" and data.get("success") is not True:
        raise RuntimeError("API operation failed (see saved response)")
    if data.get("status") == "failed" or data.get("success") is False:
        raise RuntimeError("API operation failed (see saved response)")
    return data
