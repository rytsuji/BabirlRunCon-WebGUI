# Babirl Runcon GUI

Requires Python 3.9 or later.

## Start the Web GUI

1. Edit `server.yaml`:

   ```yaml
   host: 0.0.0.0
   port: 8080
   experiments_dir: experiments
   ```

   Use `127.0.0.1` for access from the GUI server only. Change `port` as needed.

2. Run from the GUI directory:

   ```sh
   sh run.sh
   ```

   The script creates `.venv` and installs the required Python libraries.

3. Open `http://<GUI-server-IP>:8080/` in a browser. On the GUI server, use
   `http://localhost:8080/`. Replace `8080` with the port in `server.yaml`.

## Connect to babirl

Run **babirl-runcon-api** separately to control babirl.

In the Web GUI, create an experiment and enter its Event Builder host and
Run Control API base URL, for example `http://<API-server-IP>:5000`.
These settings and additional Start/Stop/Restart/Monitor APIs can also be registered
and edited through **Edit configuration**.

Use the **Background monitoring** toggle on each experiment card to keep DAQ
state and counters updated without a browser. It defaults to OFF, is saved in
experiment.yaml, and stays enabled after restarting the GUI. Copies start OFF.
OFF stops background collection; opening the control page and Refresh still work.
While a control page is open, babild Run state is checked about every 2 seconds
even with Background monitoring OFF. External babicon Start/Stop changes are
reflected without reloading. A confirmed external Stop closes the matching Run
record and cancels its timer without sending commands or executing GUI Stop APIs.
DAQ state and ES health are separate: an ES read failure does not change babild's
state. While IDLE, ES health is shown in Connections and clears on a successful
check. A GUI Stop completes when babild is verified IDLE; ES diagnostics do not
prevent completion. Controls stay locked until its history save and Stop APIs finish.
Run one GUI process per experiments directory.

Update and restart babirl-runcon-api before enabling background monitoring.
These Python-only API changes do not require rebuilding the native library.

Background state reads run about every 2 seconds. EB/ES counters use Event polling
interval (default 2 seconds). IDLE ES connection checks remain about every 2 seconds
and do not reconnect ES. Configuration and EF lists are read initially, on Refresh,
on a new collection, and after settings/operation updates. Slow or failed reads can
delay these intervals; requests do not accumulate. Raw Data remains display-only.

Monitor APIs use GET. With background monitoring OFF, they update only while the
Run Control tab is visible. With it ON, enabled Monitor APIs also run without a
browser, respecting their configured interval, timeout and Running/IDLE timing.
Results and in-progress reads are shared across browsers. They refresh on state
transitions. DAQ arguments use the shared Run overview data.

For an external notification service, use
http://<GUI-server-IP>:<port>/api/experiments/<ID>/notification-snapshot .
This returns retained data only and never triggers a DAQ request. observed_at is
the last successful Run-state read, not the response time or counter-read time.
timestamps includes the last configuration, EB-counter and ES-counter successes.
Read failures retain previous values and success times, with error details.
monitoring_enabled reports the toggle; it does not stop an external LINE service.
Only necessary Run fields and the latest Start/NSSTA operation summary are exposed.
Run start times come from babild with one-second resolution; same-name restarts
within the same second cannot be distinguished by runname + start_time.
Use Send DAQ arguments to pass shared Run overview values, getconfig or Run history as
query parameters to a Monitor API. JSON objects are encoded as JSON strings.
Choose **Before Start** or **After Start** for each Start API, and **Before Stop**
or **After Stop** for each Stop API. Existing APIs default to Before Start and
After Stop. APIs run in list order within each timing. Their failures and timeouts
are shown in Operation but do not fail DAQ control or prevent later APIs.
For After APIs, choose **Success only** (default) or **Success or failure**.
The latter also posts when an attempted DAQ command fails. Rejected preflight
checks do not create a Run or post an unrelated previous Run. A timeout warning
while waiting is not a final outcome; After APIs run once the operation finishes.
Run history is saved before posting. Successful Stop posts a completed record;
failure posts its last saved information and error, which may lack final DAQ values. Enable Also run for NSSTA to use an API for NSSTA.
Before Stop arguments use the latest shared overview without delaying Stop for
another DAQ read.

Uncheck Enabled to pause additional APIs while keeping their settings.
The Run Control API is always enabled.

Use **Copy** in the experiment list to reuse settings. Enter a new name and,
optionally, a URL path (ID). The description starts blank; Run history is not copied.

Enter an **Ender** below Header before pressing Stop. It is sent with Stop and
stored by babirl when closing a saved Run. Blank uses `no ender`.
Header and Ender each accept at most 79 UTF-8 bytes.
Both input drafts are remembered per experiment in the current browser and survive
Stop and page reloads. Before the first saved Header, the input uses DAQ readback.

Enable **Timer** above the Run buttons and enter hours, minutes and seconds.
Start with the normal **Start** or **NSSTA** button. Time is counted after DAQ
start is confirmed. Enable **Repeat** and set **Total Runs**, including the first
Run, to repeat the same mode after each normal Stop and its Stop APIs finish.
During repetition, **Stop** finishes the current timed Run without starting another;
**Manual Stop** sends Stop immediately and cancels repetition. Manual Stop, Restart
DAQ and completion reset the count. DAQ errors stop automatic scheduling.
Timer duration and repeat settings are fixed while a timer is active.
Header/Ender switches appear only with Repeat enabled. They are **Editable** while
IDLE, lock at each Start/NSSTA and unlock again when Stop completes.
During acquisition, use the switch beside Header or Ender to change **Locked** to
**Editable**. Header edits apply to the next Start; Ender edits apply to the next
Stop, including the current Run when edited during acquisition. Valid edits are
sent automatically. The current Run's Header is not changed.
Timer and Repeat switches, duration and total Runs are remembered per experiment
in the current browser. Completed counts are shown in black and reset on completion
or manual Stop/Restart.
Timers continue across browser reloads and tab changes, but do not resume after
the GUI server is restarted.

Register **Manual APIs** in Edit configuration, then run them from the **API** tab.
Choose GET or POST, query parameters or a POST JSON body, and each argument's source.
Choose availability with **Every time**, **During running** (including NSSTA), or
**During IDLE**. The GUI and server check the DAQ state before execution.
While a conditional API is pending, Run controls are locked until the response,
failure or timeout. Switching tabs does not cancel the request or release the lock.
Every time APIs do not lock Run controls.
**Free input** creates an input in the API tab. Its template is a placeholder only;
an empty input sends an empty string. The latest response appears in the Output box beside that API.
Uncheck Enabled in the configuration to prevent an API from running.

If the API requires a token, set its environment variable before starting the
GUI and enter that variable name in the API settings.

Monitor and Every time manual API arguments use the shared Run overview values.
Start/Stop API arguments use the snapshot verified for that transition.
EF List, HD List and babissm tabs reuse the shared snapshot for display; use their
Refresh buttons to read the latest DAQ settings. Writes always check the live DAQ
state and verify their results.

Use **Show Run History** on an experiment card to view saved Runs without starting
babirl or the Run Control API. This page uses the same Mode, Details and JSON views
as the Run History tab and does not contact DAQ.
Runs with recorded DAQ acquisition errors finish as **aborted**, even if Stop
succeeds or the ES recovers before Stop. Normal Runs finish as **completed**.
Additional API failures do not change the Run outcome. After Stop APIs receive
the same saved Run JSON as Run History.

Register **File size APIs** (such as `monitor_file` `/size`) in Edit configuration to
record each DAQ's file size (`data.bytes`) after a saved Stop and plot the rate
and relative deviation under **Run History**. Use **Fetch missing** or **Re-fetch all**
to read sizes for earlier Runs.

Register a **Title** and **Link** under **Links** in Edit configuration.
The **Link** tab is always shown at the end of the tabs and opens links in a new tab.

In **Edit configuration**, expand the **APIs** groups to edit individual APIs.
Add a **History comment** before Save to keep a commented snapshot, including when
the configuration is unchanged. Restore a snapshot using **Restore this configuration**.
**Delete** removes only the selected configuration history entry after confirmation;
the current settings and Run history stay intact.

Experiment settings and Run history are saved in `experiments/`. Keep that
directory and your `server.yaml` when updating the GUI.

Stop the GUI with Ctrl+C. Restart it after editing `server.yaml`.
