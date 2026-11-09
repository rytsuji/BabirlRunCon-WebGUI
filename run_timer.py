"""Server-owned timed Runs using the normal Run Control operations."""
import asyncio
import time
from uuid import uuid4

from fastapi import HTTPException


class RunTimers:
    def __init__(self, service, monitor):
        self.service = service
        self.monitor = monitor
        self.plans = {}
        self.owners = {}
        self.tasks = set()
        self.submit = None
        service.timer_owners = self.owners

    def public(self, eid):
        plan = self.plans.get(eid)
        if not plan:
            return None
        return {key: plan[key] for key in (
            'id', 'active', 'phase', 'mode', 'duration_sec', 'repeat',
            'total_runs', 'completed_runs', 'finish_requested', 'message', 'header', 'ender')
        } | {'remaining_runs': max(0, plan['total_runs'] - plan['completed_runs']),
             'remaining_sec': max(0, int(plan['deadline'] - time.monotonic() + .999))
             if plan.get('deadline') else None}

    def finish(self, eid):
        plan = self.plans.get(eid)
        if not plan or not plan['active']:
            raise HTTPException(409, 'No active Run timer.')
        plan['finish_requested'] = True
        plan['message'] = 'Finishing after the current timed Run.'
        return self.public(eid)

    def update_comments(self, eid, plan_id, header=None, ender=None):
        plan = self.plans.get(eid)
        if not plan or not plan['active'] or plan['id'] != plan_id:
            raise HTTPException(409, 'Run timer changed or is no longer active.')
        if header is not None:
            plan['header'] = header
        if ender is not None:
            plan['ender'] = ender
        return self.public(eid)

    async def cancel(self, eid, message='Timer cancelled by manual control.'):
        plan = self.plans.get(eid)
        if plan:
            was_active = plan['active']
            plan.update(active=False, phase='cancelled', completed_runs=0,
                        deadline=None, message=message)
            if self.owners.get(plan['key']) is plan:
                self.owners.pop(plan['key'], None)
            if was_active:
                plan['task'].cancel()
                await asyncio.gather(plan['task'], return_exceptions=True)

    def begin(self, eid, config, spec, mode, header, ender, operation):
        key = self.service.key(config)
        if key in self.owners:
            raise HTTPException(409, 'A Run timer is already active on this EB.')
        plan = dict(id=uuid4().hex, experiment_id=eid, key=key, active=True,
                    phase='starting', mode=mode, duration_sec=spec.duration_sec,
                    repeat=spec.repeat, total_runs=spec.total_runs if spec.repeat else 1,
                    completed_runs=0, finish_requested=False, deadline=None,
                    header=header, ender=ender,
                    message='Waiting for DAQ to start.')
        self.plans[eid] = plan
        self.owners[key] = plan
        task = asyncio.create_task(self.run(plan, config, operation))
        plan['task'] = task
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def check_errors(self, plan, config):
        if self.service.store.control_errors(plan['experiment_id']):
            raise RuntimeError('DAQ errors detected. Automatic Run control stopped; use manual Stop or Restart DAQ.')
        state = self.monitor.arguments(plan['experiment_id'], config)
        if state.get('acquisition_errors'):
            raise RuntimeError('DAQ read error. Automatic Run control stopped; use manual Stop or Restart DAQ.')

    async def wait_operation(self, plan, config, operation):
        # Cancellation stops scheduling only; an accepted DAQ command is never cancelled.
        while operation['status'] in ('queued', 'running'):
            self.check_errors(plan, config)
            if operation.get('wait_timed_out') or operation.get('stop_error'):
                raise RuntimeError('DAQ operation timed out or failed. Automatic Run control stopped.')
            await asyncio.sleep(.1)
        if operation['status'] != 'succeeded':
            raise RuntimeError(operation.get('message') or 'DAQ operation failed.')
        self.check_errors(plan, config)

    async def run(self, plan, config, operation):
        eid = plan['experiment_id']
        try:
            while plan['active']:
                await self.wait_operation(plan, config, operation)
                plan.update(phase='running', deadline=time.monotonic() + plan['duration_sec'],
                            message='Timed acquisition in progress.')
                while time.monotonic() < plan['deadline']:
                    self.check_errors(plan, config)
                    await asyncio.sleep(min(.25, max(0, plan['deadline'] - time.monotonic())))
                plan.update(phase='stopping', deadline=None, message='Waiting for normal Stop and Stop APIs.')
                # Conditional manual APIs keep the same lock as manual Run controls.
                while plan['key'] in self.service.manual_active or plan['key'] in self.service.active:
                    self.check_errors(plan, config)
                    await asyncio.sleep(.1)
                operation = await self.submit(eid, 'stop', '', plan['ender'])
                await self.wait_operation(plan, config, operation)
                plan['completed_runs'] += 1
                if plan['finish_requested'] or plan['completed_runs'] >= plan['total_runs']:
                    plan.update(active=False, phase='completed', completed_runs=0,
                                message='Timed acquisition completed. Count reset.')
                    break
                plan.update(phase='starting', message='Starting the next timed Run.')
                operation = await self.submit(eid, plan['mode'], plan['header'], '')
        except asyncio.CancelledError:
            if plan['active']:
                plan.update(active=False, phase='cancelled', message='GUI server stopped. Timer will not resume automatically.')
        except Exception as exc:
            detail = getattr(exc, 'detail', None) or str(exc)
            plan.update(active=False, phase='failed', deadline=None, message=detail)
        finally:
            if self.owners.get(plan['key']) is plan:
                self.owners.pop(plan['key'], None)

    async def close(self):
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
