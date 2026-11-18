import html
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
from fastapi import FastAPI
from pydantic import BaseModel

BASE = Path(__file__).resolve().parent
CONFIG_PATH = BASE / "alarm_config.json"

STATUS_CONDITIONS: List[Dict[str, str]] = [
    {"id": "disconnected", "label": "Connection lost / refused (ES / EB / API)"},
    {"id": "state_error", "label": "DAQ state error / control command failure"},
    {"id": "acquisition", "label": "Acquisition / event counter read error"},
    {"id": "api_monitor", "label": "Monitor failure / API HTTP error"},
]

DEFAULT_DETECTORS: Dict[str, str] = {
    "eb": "Event Builder (EB / babild)",
    "api": "Run Control API",
    "daq": "DAQ System / General",
}


def _default_config() -> Dict[str, Any]:
    return {
        "enabled": True,
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
    return cfg


def _save_config(cfg: Dict[str, Any]) -> None:
    try:
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    except Exception:
        pass


def render_alarm_panel(cfg: Dict[str, Any]) -> str:
    enabled = bool(cfg.get("enabled", True))
    statuses: Dict[str, bool] = cfg.get("statuses", {})
    detectors: Dict[str, bool] = cfg.get("detectors", {})
    labels: Dict[str, str] = cfg.get("detector_labels", {})

    detector_rows = []
    for det_id, label in labels.items():
        checked = "checked" if detectors.get(det_id, True) else ""
        detector_rows.append(
            f'<label class="check-label">'
            f'<input type="checkbox" data-alarm-detector="{html.escape(det_id)}" {checked}>'
            f'{html.escape(label)}'
            f'</label>'
        )

    status_rows = []
    for st in STATUS_CONDITIONS:
        st_id = st["id"]
        checked = "checked" if statuses.get(st_id, True) else ""
        status_rows.append(
            f'<label class="check-label">'
            f'<input type="checkbox" data-alarm-status="{html.escape(st_id)}" {checked}>'
            f'{html.escape(st["label"])}'
            f'</label>'
        )

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
        <div class="two-columns">
          <div class="field">
            <div class="actions" style="justify-content:space-between">
              <label>Target Detectors / Nodes / Monitors</label>
              <div class="actions">
                <button class="button small" type="button" data-alarm-bulk="det-all">All</button>
                <button class="button small" type="button" data-alarm-bulk="det-none">None</button>
              </div>
            </div>
            {"".join(detector_rows)}
          </div>
          <div class="field">
            <div class="actions" style="justify-content:space-between">
              <label>Target Status Conditions</label>
              <div class="actions">
                <button class="button small" type="button" data-alarm-bulk="st-all">All</button>
                <button class="button small" type="button" data-alarm-bulk="st-none">None</button>
              </div>
            </div>
            {"".join(status_rows)}
          </div>
        </div>
        <p class="form-note">Repeats every 3 seconds when a checked item and status condition occur. Remains active until Stop Alarm is clicked.</p>
      </div>
    </div>
    """.strip()


class DetectorMeta(BaseModel):
    label: str
    default_enabled: bool = True


class AlarmConfigUpdate(BaseModel):
    enabled: Optional[bool] = None
    statuses: Optional[Dict[str, bool]] = None
    detectors: Optional[Dict[str, bool]] = None
    register_detectors: Optional[Dict[str, Union[DetectorMeta, str]]] = None


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
        changed = False
        if payload.enabled is not None:
            alarm_state["enabled"] = bool(payload.enabled)
            changed = True
        if payload.statuses is not None:
            for k, v in payload.statuses.items():
                if k in alarm_state["statuses"]:
                    alarm_state["statuses"][k] = bool(v)
                    changed = True
        if payload.register_detectors is not None:
            for det_id, meta in payload.register_detectors.items():
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
        if payload.detectors is not None:
            for det_id, v in payload.detectors.items():
                alarm_state["detectors"][det_id] = bool(v)
                alarm_state["detector_labels"].setdefault(det_id, det_id)
                changed = True
        if changed:
            _save_config(alarm_state)
        return _response_payload()
