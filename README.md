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

Monitor APIs use GET and update their latest result only while the Run Control
tab is visible. Configure their interval, timeout and timing in Edit configuration.
They also refresh after Start, NSSTA and Stop transitions. If a request is already
pending, one refresh is queued. DAQ arguments wait for the first Run overview data
and then use its shared snapshot.
Use Send DAQ arguments to pass shared Run overview values, getconfig or Run history as
query parameters to a Monitor API. JSON objects are encoded as JSON strings.
Uncheck Enabled to pause additional APIs while keeping their settings.
The Run Control API is always enabled.

Use **Copy** in the experiment list to reuse settings. Enter a new name and,
optionally, a URL path (ID). The description starts blank; Run history is not copied.

Enter an **Ender** below Header before pressing Stop. It is sent with Stop and
stored by babirl when closing a saved Run. Blank uses `no ender`.
Header and Ender each accept at most 79 UTF-8 bytes.

Enable **Timer** above the Run buttons and enter hours, minutes and seconds.
Start with the normal **Start** or **NSSTA** button. Time is counted after DAQ
start is confirmed. Enable **Repeat** and set **Total Runs**, including the first
Run, to repeat the same mode after each normal Stop and its Stop APIs finish.
During repetition, **Stop** finishes the current timed Run without starting another;
**Manual Stop** sends Stop immediately and cancels repetition. Manual Stop, Restart
DAQ and completion reset the count. DAQ errors stop automatic scheduling.
Timer settings, Header and Ender are fixed while a timer is active.
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

In **Edit configuration**, expand the **APIs** groups to edit individual APIs.
Add a **History comment** before Save to keep a commented snapshot, including when
the configuration is unchanged. Restore a snapshot using **Restore this configuration**.
**Delete** removes only the selected configuration history entry after confirmation;
the current settings and Run history stay intact.

Experiment settings and Run history are saved in `experiments/`. Keep that
directory and your `server.yaml` when updating the GUI.

Stop the GUI with Ctrl+C. Restart it after editing `server.yaml`.
