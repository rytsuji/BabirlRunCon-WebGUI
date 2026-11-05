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
Use Send DAQ arguments to pass cached DAQ values, getconfig or Run history as
query parameters to a Monitor API. JSON objects are encoded as JSON strings.
Uncheck Enabled to pause additional APIs while keeping their settings.
The Run Control API is always enabled.

If the API requires a token, set its environment variable before starting the
GUI and enter that variable name in the API settings.

Experiment settings and Run history are saved in `experiments/`. Keep that
directory and your `server.yaml` when updating the GUI.

Stop the GUI with Ctrl+C. Restart it after editing `server.yaml`.
