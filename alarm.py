import html
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
from fastapi import FastAPI
from pydantic import BaseModel

BASE = Path(__file__).resolve().parent
CONFIG_PATH = BASE / "alarm_config.json"

STATUS_CONDITIONS: List[Dict[str, str]] = [
    {
        "id": "disconnected",
        "label": "Connection lost / refused",
        "desc": "ES nodes, Event Builder (EB), or Run Control API disconnected",
    },
    {
        "id": "state_error",
        "label": "DAQ state error / command failure",
        "desc": "DAQ state is ERROR, or Start / Stop / Restart operation failed",
    },
    {
        "id": "acquisition",
        "label": "Acquisition / readout error",
        "desc": "Event counter or readout error reported during run",
    },
    {
        "id": "api_monitor",
        "label": "Monitor / HTTP API failure",
        "desc": "Monitor API returned FAIL / ERROR / TIMEOUT, or HTTP request failed",
    },
]

DEFAULT_DETECTORS: Dict[str, str] = {
    "eb": "Event Builder (EB)",
    "api": "Run Control API",
    "daq": "DAQ System / General (state & readout)",
}

SYNTHETIC_MONITOR_RE = re.compile(r"^monitor:Monitor #\d+$")


def _clean_stale_entries(cfg: Dict[str, Any]) -> bool:
    changed = False
    detectors = cfg.get("detectors", {})
    labels = cfg.get("detector_labels", {})

    for key in list(detectors.keys()):
        if SYNTHETIC_MONITOR_RE.match(key):
            detectors.pop(key, None)
            labels.pop(key, None)
            changed = True

    for key in list(labels.keys()):
        if SYNTHETIC_MONITOR_RE.match(key):
            labels.pop(key, None)
            changed = True

    if labels.get("es_all") == "Event Senders (Common)":
        labels["es_all"] = "ES Common (overall ES query error)"
        changed = True

    return changed


def _default_config() -> Dict[str, Any]:
    return {
        "enabled": True,
        "timer_notify": True,
        "timer_repeat": True,
        "statuses": {item["id"]: True for item in STATUS_CONDITIONS},
        "detectors": {det_id: True for det_id in DEFAULT_DETECTORS},
        "detector_labels": dict(DEFAULT_DETECTORS),
    }


def _load_config() -> Dict[str, Any]:
    cfg = _default_config()
    if CONFIG_PATH.exists():
        try:
            saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                if "enabled" in saved:
                    cfg["enabled"] = bool(saved["enabled"])
                if "timer_notify" in saved:
                    cfg["timer_notify"] = bool(saved["timer_notify"])
                if "timer_repeat" in saved:
                    cfg["timer_repeat"] = bool(saved["timer_repeat"])
                if isinstance(saved.get("statuses"), dict):
                    for k, v in saved["statuses"].items():
                        if k in cfg["statuses"]:
                            cfg["statuses"][k] = bool(v)
                if isinstance(saved.get("detector_labels"), dict):
                    for k, v in saved["detector_labels"].items():
                        if isinstance(v, str) and v:
                            cfg["detector_labels"][k] = v
                if isinstance(saved.get("detectors"), dict):
                    for k, v in saved["detectors"].items():
                        cfg["detectors"][k] = bool(v)
                        cfg["detector_labels"].setdefault(k, k)
        except Exception:
            pass
    if _clean_stale_entries(cfg):
        _save_config(cfg)
    return cfg


def _save_config(cfg: Dict[str, Any]) -> None:
    try:
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    except Exception:
        pass


def _es_sort_key(det_id: str):
    if det_id == "es_all":
        return (1, 999999, det_id)
    m = re.match(r"^es_(\d+)$", det_id)
    if m:
        return (0, int(m.group(1)), det_id)
    return (0, 999998, det_id)


def render_alarm_panel(cfg: Dict[str, Any]) -> str:
    enabled = bool(cfg.get("enabled", True))
    timer_notify = bool(cfg.get("timer_notify", True))
    timer_repeat = bool(cfg.get("timer_repeat", True))
    statuses: Dict[str, bool] = cfg.get("statuses", {})
    detectors: Dict[str, bool] = cfg.get("detectors", {})
    labels: Dict[str, str] = cfg.get("detector_labels", {})

    core_ids = [k for k in ("eb", "api", "daq") if k in labels]
    es_ids = sorted(
        [k for k in labels if k == "es_all" or k.startswith("es_")],
        key=_es_sort_key,
    )
    monitor_ids = [k for k in labels if k.startswith("monitor:")]
    other_ids = [
        k for k in labels
        if k not in core_ids and k not in es_ids and k not in monitor_ids
    ]

    def render_checkbox(det_id: str) -> str:
        raw_label = labels.get(det_id, det_id)
        if det_id.startswith("monitor:") and raw_label.startswith("Monitor: "):
            raw_label = raw_label[len("Monitor: "):]
        checked = "checked" if detectors.get(det_id, True) else ""
        return (
            f'<label class="check-label">'
            f'<input type="checkbox" data-alarm-detector="{html.escape(det_id)}" {checked}>'
            f'<span>{html.escape(raw_label)}</span>'
            f'</label>'
        )

    def render_group(title: str, subtitle: str, ids: List[str]) -> str:
        if not ids:
            return ""
        rows = "".join(render_checkbox(i) for i in ids)
        return (
            f'<div style="border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin-bottom:8px;background:#fafbfd">'
            f'<div style="font-size:11px;font-weight:700;color:#24549d;margin-bottom:2px">{html.escape(title)}</div>'
            f'<div style="font-size:10px;color:var(--muted);margin-bottom:6px">{html.escape(subtitle)}</div>'
            f'{rows}'
            f'</div>'
        )

    grouped_detectors_html = (
        render_group(
            "1. Core DAQ & Control",
            "Main event builder, run control API, and general DAQ state/readout",
            core_ids + other_ids,
        )
        + render_group(
            "2. Event Senders (ES)",
            "Individual front-end nodes (efn) and overall ES connection query",
            es_ids,
        )
        + render_group(
            "3. Monitor APIs",
            "External status monitors defined in the experiment configuration",
            monitor_ids,
        )
    )

    status_rows = []
    for st in STATUS_CONDITIONS:
        st_id = st["id"]
        checked = "checked" if statuses.get(st_id, True) else ""
        status_rows.append(
            f'<div style="border:1px solid var(--line);border-radius:6px;padding:7px 10px;margin-bottom:7px;background:#fafbfd">'
            f'<label class="check-label" style="margin-bottom:2px;font-weight:600">'
            f'<input type="checkbox" data-alarm-status="{html.escape(st_id)}" {checked}>'
            f'<span>{html.escape(st["label"])}</span>'
            f'</label>'
            f'<div style="font-size:10px;color:var(--muted);padding-left:22px">{html.escape(st["desc"])}</div>'
            f'</div>'
        )

    timer_box_html = f"""
    <div style="border:1px solid #dce7ff;border-radius:6px;padding:8px 10px;margin-top:10px;background:#f4f7fd">
      <div class="actions" style="justify-content:space-between;margin-bottom:4px">
        <span style="font-size:11px;font-weight:700;color:#24549d">Run Timer Completion Notice</span>
        <div class="actions">
          <button class="button small" type="button" id="alarm-timer-test-btn">Test Chime</button>
          <button class="button small blue" type="button" id="alarm-timer-dismiss-btn" hidden>Dismiss</button>
        </div>
      </div>
      <label class="check-label" style="margin-bottom:4px">
        <input type="checkbox" data-alarm-timer="notify" {"checked" if timer_notify else ""}>
        <span>Play completion chime when timed Run stops</span>
      </label>
      <label class="check-label">
        <input type="checkbox" data-alarm-timer="repeat" {"checked" if timer_repeat else ""}>
        <span>Repeat chime every 4 seconds until dismissed</span>
      </label>
    </div>
    """

    return f"""
    <div class="panel utility-panel">
      <div class="panel-head">
        <h2>Alarm Settings</h2>
        <div class="actions">
          <label class="check-label lock-switch">
            <input type="checkbox" role="switch" id="alarm-master-toggle" {"checked" if enabled else ""}>
            Audible alarm <span id="alarm-master-state">{"ON" if enabled else "OFF"}</span>
          </label>
          <button class="button small" type="button" id="alarm-test-btn">Test Sound</button>
          <button class="button small danger" type="button" id="alarm-stop-btn" hidden>Stop Alarm</button>
        </div>
      </div>
      <div class="panel-body">
        <div id="alarm-active-notice" class="notice red section" role="alert" hidden></div>
        <div id="alarm-timer-notice" class="notice section" role="status" hidden></div>
        <div class="two-columns">
          <div class="field">
            <div class="actions" style="justify-content:space-between;margin-bottom:6px">
              <label style="margin:0">Target Nodes & Monitors</label>
              <div class="actions">
                <button class="button small" type="button" data-alarm-bulk="det-all">All</button>
                <button class="button small" type="button" data-alarm-bulk="det-none">None</button>
              </div>
            </div>
            {grouped_detectors_html}
          </div>
          <div class="field">
            <div class="actions" style="justify-content:space-between;margin-bottom:6px">
              <label style="margin:0">Target Error Conditions</label>
              <div class="actions">
                <button class="button small" type="button" data-alarm-bulk="st-all">All</button>
                <button class="button small" type="button" data-alarm-bulk="st-none">None</button>
              </div>
            </div>
            {"".join(status_rows)}
            {timer_box_html}
          </div>
        </div>
        <p class="form-note">Error alarm triggers when BOTH a checked target and a checked error condition occur (repeats every 3s until Stop Alarm is clicked). Timer completion chime triggers when a timed Run finishes.</p>
      </div>
    </div>
    """.strip()


class DetectorMeta(BaseModel):
    label: str
    default_enabled: bool = True


class AlarmConfigUpdate(BaseModel):
    enabled: Optional[bool] = None
    timer_notify: Optional[bool] = None
    timer_repeat: Optional[bool] = None
    statuses: Optional[Dict[str, bool]] = None
    detectors: Optional[Dict[str, bool]] = None
    register_detectors: Optional[Dict[str, Union[DetectorMeta, str]]] = None
    valid_monitor_ids: Optional[List[str]] = None


def install_alarm(app: FastAPI, build_id: Optional[str] = None):
    alarm_state = _load_config()

    def _response_payload() -> Dict[str, Any]:
        return {
            **alarm_state,
            "panel_html": render_alarm_panel(alarm_state),
        }

    @app.get("/api/alarm")
    async def get_alarm():
        return _response_payload()

    @app.post("/api/alarm")
    async def set_alarm(payload: AlarmConfigUpdate):
        changed = _clean_stale_entries(alarm_state)

        if payload.enabled is not None:
            alarm_state["enabled"] = bool(payload.enabled)
            changed = True

        if payload.timer_notify is not None:
            alarm_state["timer_notify"] = bool(payload.timer_notify)
            changed = True

        if payload.timer_repeat is not None:
            alarm_state["timer_repeat"] = bool(payload.timer_repeat)
            changed = True

        if payload.statuses is not None:
            for k, v in payload.statuses.items():
                if k in alarm_state["statuses"]:
                    alarm_state["statuses"][k] = bool(v)
                    changed = True

        if payload.register_detectors is not None:
            for det_id, meta in payload.register_detectors.items():
                if SYNTHETIC_MONITOR_RE.match(det_id):
                    continue
                if isinstance(meta, DetectorMeta):
                    label = meta.label or det_id
                    default_en = bool(meta.default_enabled)
                else:
                    label = str(meta) or det_id
                    default_en = "strasse" not in label.lower()

                if det_id not in alarm_state["detectors"]:
                    alarm_state["detectors"][det_id] = default_en
                    alarm_state["detector_labels"][det_id] = label
                    changed = True
                elif label and alarm_state["detector_labels"].get(det_id) != label:
                    alarm_state["detector_labels"][det_id] = label
                    changed = True

        if payload.valid_monitor_ids is not None:
            valid_set = set(payload.valid_monitor_ids)
            for key in list(alarm_state["detectors"].keys()):
                if key.startswith("monitor:") and key not in valid_set:
                    alarm_state["detectors"].pop(key, None)
                    alarm_state["detector_labels"].pop(key, None)
                    changed = True

        if payload.detectors is not None:
            for det_id, v in payload.detectors.items():
                if SYNTHETIC_MONITOR_RE.match(det_id):
                    continue
                alarm_state["detectors"][det_id] = bool(v)
                alarm_state["detector_labels"].setdefault(det_id, det_id)
                changed = True

        if changed:
            _save_config(alarm_state)
        return _response_payload()
