"""Per-Run DAQ file sizes from display-only GET APIs; never part of DAQ control."""
import asyncio
import json
import logging
from datetime import datetime

import httpx

from controllers import auth_headers
from storage import now

logger = logging.getLogger(__name__)
MAX_RESPONSE_BYTES = 1048576


def live_time_sec(run):
    """Live time used for normalization: babirl Stop - Start in seconds, or None."""
    info = (run.get('daq_config') or {}).get('runinfo') or {}
    start, stop = info.get('starttime'), info.get('stoptime')
    if all(type(value) in (int, float) and value > 0 for value in (start, stop)):
        seconds = stop - start
    else:
        try:
            seconds = (datetime.fromisoformat(run['finished_at']) - datetime.fromisoformat(run['started_at'])).total_seconds()
        except (KeyError, TypeError, ValueError):
            return None
    return seconds if seconds > 0 else None


def public_run(run):
    return {'id': run['_rowid'], 'runname': run['runname'], 'runnumber': run['runnumber'],
            'started_at': run.get('started_at'), 'finished_at': run.get('finished_at'),
            'live_time_sec': live_time_sec(run), 'event_num': run.get('event_num'),
            'sizes': run.get('file_sizes', {})}


async def read_size(client, endpoint, runname, runnumber):
    """Ask one DAQ's API for the total bytes of a Run's files."""
    checked_at = now()

    def failed(message, unreachable=False):
        return {'bytes': None, 'file_count': None, 'error': message, 'checked_at': checked_at, 'unreachable': unreachable}

    async def fetch():
        url = httpx.URL(endpoint.api).copy_merge_params({'runname': runname, 'runnumber': str(runnumber)})
        async with client.stream('GET', url, headers=auth_headers(endpoint),
                                 timeout=endpoint.timeout_sec, follow_redirects=False) as response:
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise ValueError('File size response exceeds 1 MiB')
            return response, json.loads(body)

    try:
        response, payload = await asyncio.wait_for(fetch(), endpoint.timeout_sec)
    except (asyncio.TimeoutError, httpx.TimeoutException):
        return failed(f'Timed out after {endpoint.timeout_sec:g} seconds', True)
    except httpx.TransportError as exc:
        return failed(str(exc) or type(exc).__name__, True)
    except json.JSONDecodeError:
        return failed('Response is not JSON')
    except Exception as exc:
        return failed(str(exc) or type(exc).__name__)
    payload = payload if isinstance(payload, dict) else {}
    data = payload.get('data') if isinstance(payload.get('data'), dict) else {}
    size = data.get('bytes')
    if payload.get('status') != 'ok' or not response.is_success or type(size) is not int or size < 0:
        detail = data.get('message') or payload.get('message') or payload.get('detail')
        return failed(str(detail) if detail else f'HTTP {response.status_code}')
    files = data.get('file')
    return {'bytes': size, 'file_count': len(files) if isinstance(files, list) else None,
            'error': None, 'checked_at': checked_at}


async def collect_after_stop(store, client, eid, rowid, runname, runnumber):
    """Record every enabled DAQ's size for a just-completed saved Run."""
    try:
        config, _, _ = store.read_config(eid)
    except Exception:
        logger.exception('File sizes skipped: configuration unreadable')
        return

    async def one(endpoint):
        # Let DAQ processes that follow babirl close their files first.
        await asyncio.sleep(endpoint.delay_sec)
        result = await read_size(client, endpoint, runname, runnumber)
        result.pop('unreachable', None)
        # The experiment may have been deleted or moved to a new ID meanwhile.
        if store.config_path(eid).is_file():
            store.put_file_size(eid, rowid, endpoint.name, result)

    results = await asyncio.gather(*(one(endpoint) for endpoint in config.file_size_api if endpoint.enabled),
                                   return_exceptions=True)
    for result in results:
        if isinstance(result, Exception):
            logger.error('File size record failed for %s', eid, exc_info=result)


async def refresh(store, client, eid, config, limit, force):
    """Read sizes for the latest Runs: missing or failed ones, or every one with force.
    Requests to one DAQ are sequential and stop after that DAQ is unreachable."""
    runs = store.file_size_runs(eid, limit)
    summary = {'requested': 0, 'updated': 0, 'skipped': 0, 'errors': []}

    async def per_source(endpoint):
        unreachable = None
        for run in runs:
            recorded = run['file_sizes'].get(endpoint.name)
            if not force and recorded and recorded['bytes'] is not None:
                continue
            summary['requested'] += 1
            if unreachable:
                summary['skipped'] += 1
                continue
            result = await read_size(client, endpoint, run['runname'], run['runnumber'])
            if result.pop('unreachable', False):
                unreachable = result['error']
            if store.put_file_size(eid, run['_rowid'], endpoint.name, result) and result['bytes'] is not None:
                summary['updated'] += 1
            if result['error']:
                summary['errors'].append({'source': endpoint.name, 'runname': run['runname'],
                                          'runnumber': run['runnumber'], 'error': result['error']})

    await asyncio.gather(*(per_source(endpoint) for endpoint in config.file_size_api if endpoint.enabled))
    summary['error_count'] = len(summary['errors'])
    summary['errors'] = summary['errors'][:20]
    return summary
