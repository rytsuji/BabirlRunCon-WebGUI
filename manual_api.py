"""Explicit API requests, independent of DAQ operation and error records."""
import asyncio
import json

import httpx

from controllers import auth_headers
from storage import now


async def execute_manual(client, endpoint, arguments, request, state, store, eid):
    async def execute():
        values = {}
        if endpoint.send_query_params:
            for argument in endpoint.query_params:
                if argument.source == 'custom':
                    value = arguments.get(argument.name, '')
                elif argument.source == 'getconfig_json':
                    value = state.get('raw_config')
                elif argument.source == 'run_history_json':
                    value = [store.public_run(run) for run in store.runs(eid)]
                elif argument.source == 'current_run_json':
                    runs = store.runs(eid, limit=1)
                    value = store.public_run(runs[0]) if runs else None
                else:
                    value = state.get(argument.source)
                if value is None:
                    raise ValueError(f'DAQ value is unavailable: {argument.source}')
                values[argument.name] = value if endpoint.argument_transport == 'json' else (
                    json.dumps(value,ensure_ascii=False,separators=(',',':')) if isinstance(value,(dict,list)) else str(value))
        url = httpx.URL(endpoint.api).copy_merge_params(values) if endpoint.argument_transport == 'query' and values else endpoint.api
        options = {'json':values} if endpoint.send_query_params and endpoint.argument_transport == 'json' else {}
        async with client.stream(endpoint.method,url,headers=auth_headers(endpoint),timeout=endpoint.timeout_sec,
                                 follow_redirects=False,**options) as response:
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body)>1048576:
                    raise ValueError('API response exceeds 1 MiB')
            try:
                data = json.loads(body)
            except (ValueError,UnicodeDecodeError):
                data = body.decode('utf-8',errors='replace')
            return {'success':response.is_success,'http_status':response.status_code,'data':data}

    async def disconnected():
        while not await request.is_disconnected():
            await asyncio.sleep(.1)

    task=asyncio.create_task(asyncio.wait_for(execute(),endpoint.timeout_sec))
    watcher=asyncio.create_task(disconnected())
    try:
        done,_=await asyncio.wait({task,watcher},return_when=asyncio.FIRST_COMPLETED)
        if watcher in done:
            raise asyncio.CancelledError()
        try:
            result=await task
        except (asyncio.TimeoutError,httpx.TimeoutException):
            result={'success':False,'error':f'Timed out after {endpoint.timeout_sec:g} seconds'}
        except Exception as exc:
            result={'success':False,'error':str(exc) or type(exc).__name__}
        return {**result,'checked_at':now()}
    finally:
        for pending in (task,watcher):
            if not pending.done():
                pending.cancel()
        await asyncio.gather(task,watcher,return_exceptions=True)
