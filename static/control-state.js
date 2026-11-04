"use strict";

// Pure availability rules shared by the UI and the frontend regression tests.
function daqControlState({status, pending, draftDirty, header, runname, runnumber, restartConfigured}) {
  const live = status?.state?.state;
  const busy = pending || !!status?.active_operation;
  const unresolved = !!status?.active_run;
  const connectionReason = !status?.connected ? "Waiting for verified EB connection."
    : busy ? "Another operation is in progress."
    : status?.eb_owner ? "This EB is controlled by another experiment."
    : !["stopped", "running", "nssta"].includes(live) ? "DAQ state is unknown. Wait for a verified state."
    : "";
  const writeReason = connectionReason || (status?.state?.target?.allow_writes === false
    ? "Run Control API is read-only (daq.allow_writes is false)." : "");
  const idleReason = writeReason || (live !== "stopped" ? "DAQ is running. Stop it before editing or starting." : "")
    || (unresolved ? "An unfinished Run exists. Use Stop or Restart DAQ to recover." : "");
  const bytes = new TextEncoder().encode(header).length;
  const headerReason = bytes > 79 || header.includes("\0") ? "Header must be at most 79 UTF-8 bytes, without NUL." : "";
  const nameReason = !runname || /\s|\0/.test(runname) || new TextEncoder().encode(runname).length > 79
    ? "Run name must be one token of at most 79 UTF-8 bytes." : "";
  const numberReason = runnumber === "" || !Number.isInteger(Number(runnumber)) || Number(runnumber) < 0 || Number(runnumber) > 2147483647
    ? "Current number must be an integer from 0 to 2147483647." : "";
  const startReason = idleReason || (status?.control_errors?.length ? "Resolve the retained DAQ errors with Stop or Restart DAQ before starting." : "") || (draftDirty ? "Set Run Name / Number before starting." : "") || headerReason;
  const setReason = idleReason || nameReason || numberReason;
  const stopBusy=pending || (!!status?.active_operation && !["start","nssta"].includes(status.active_operation.action));
  const stopReason = stopBusy ? "Another operation is in progress."
    : status?.eb_owner ? "This EB is controlled by another experiment."
    : status?.state?.target?.allow_writes===false ? "The Run Control API has writes disabled."
    : status?.connected && live==="stopped" && !unresolved && !status?.active_operation && !status?.control_errors?.length && !Object.keys(status?.state?.acquisition_errors || {}).length ? "DAQ is idle. There is no active acquisition to stop." : "";
  const restartReason = !restartConfigured ? "No Restart API configured. Add one in Edit configuration."
    : busy && !(status?.restart_unlocked && status?.active_operation?.action==='stop' && !pending) ? "Another operation is in progress."
    : status?.eb_owner ? "This EB is controlled by another experiment."
    : status?.state?.target?.allow_writes === false ? "The Run Control API has writes disabled."
    : status?.control_errors?.length && !status?.restart_unlocked ? "Attempt Stop first. Restart becomes available after the configured delay if errors remain."
    : status?.connected && ["running","nssta"].includes(live) && !status?.restart_unlocked ? "Attempt Stop first. Restart becomes available after the configured delay if errors remain." : "";
  return {bytes, editable:!idleReason, startReason, stopReason, setReason, restartReason};
}

if (typeof module !== "undefined") module.exports = {daqControlState};
