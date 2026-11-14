"""Display-only GET requests; never participate in DAQ operation state."""
import asyncio
import json
import httpx
from controllers import auth_headers
from storage import now


class WaitingForOverview(ValueError):
    pass


async def read_monitor(client,endpoint,request,state=None,store=None,eid=None):
    async def fetch():
        params = {}
        if endpoint.send_query_params:
            for argument in endpoint.query_params:
                if argument.source == 'current_run_json':
                    runs = store.runs(eid, limit=1)
                    value = store.public_run(runs[0]) if runs else None
                else:
                    key = 'raw_config' if argument.source == 'getconfig_json' else argument.source
                    value = (state or {}).get(key)
                if value is None:
                    raise WaitingForOverview(f'Waiting for Run overview data: {argument.source}')
                params[argument.name] = json.dumps(value,ensure_ascii=False,separators=(',',':')) if isinstance(value,(dict,list)) else str(value)
        url = httpx.URL(endpoint.api).copy_merge_params(params) if params else endpoint.api
        async with client.stream('GET',url,headers=auth_headers(endpoint),
                                 timeout=endpoint.timeout_sec,follow_redirects=False) as response:
            body=bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body)>1048576:raise ValueError('Monitor response exceeds 1 MiB')
            payload=json.loads(body)
            if not isinstance(payload,dict) or payload.get('status') not in ('ok','fail','error'):
                raise ValueError('Expected JSON with status ok, fail or error')
            status=payload['status']
            if not response.is_success and status=='ok':status='fail'
            return {'status':status,'data':payload.get('data'),
                    'message':str(payload.get('message') or payload.get('comment') or
                                  (f'HTTP {response.status_code}' if not response.is_success else ''))}
    async def disconnected():
        while not await request.is_disconnected():await asyncio.sleep(.1)
    task=asyncio.create_task(asyncio.wait_for(fetch(),endpoint.timeout_sec))
    watcher=asyncio.create_task(disconnected())
    try:
        done,_=await asyncio.wait({task,watcher},return_when=asyncio.FIRST_COMPLETED)
        if watcher in done:
            raise asyncio.CancelledError()
        try:result=await task
        except WaitingForOverview as exc:
            result={'status':'waiting','data':None,'message':str(exc)}
        except (asyncio.TimeoutError,httpx.TimeoutException):
            result={'status':'timeout','data':None,'message':f'Timed out after {endpoint.timeout_sec:g} seconds'}
        except Exception as exc:
            result={'status':'fail','data':None,'message':str(exc) or type(exc).__name__}
        return {**result,'checked_at':now()}
    finally:
        for pending in (task,watcher):
            if not pending.done():pending.cancel()
        await asyncio.gather(task,watcher,return_exceptions=True)
