"""Per-experiment SQLite records, YAML configuration and run recall values."""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
from uuid import uuid4
from contextlib import contextmanager
from datetime import datetime, timezone

import yaml

from models import ExperimentConfig, History, RunMemory


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".save-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def folder(self, eid):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", eid):
            raise ValueError("Invalid experiment ID")
        result = self.root / eid
        if result.resolve().parent != self.root:
            raise ValueError("Invalid experiment path")
        return result

    def config_path(self, eid):
        return self.folder(eid) / "config" / "experiment.yaml"

    def read_config(self, eid):
        raw = self.config_path(eid).read_text(encoding="utf-8")
        config = ExperimentConfig.model_validate(yaml.safe_load(raw))
        if config.experiment.id != eid:
            raise ValueError("Experiment ID must match its directory")
        return config, raw, hashlib.sha256(raw.encode()).hexdigest()

    def save_config(self, eid, raw, revision, comment=''):
        config = ExperimentConfig.model_validate(yaml.safe_load(raw))
        new_id = config.experiment.id
        destination = self.folder(new_id)
        if new_id != eid and destination.exists():
            raise ValueError("This experiment URL path is already in use.")
        _, old, current = self.read_config(eid)
        if revision != current:
            raise ValueError("Configuration changed in another session. Reload before saving.")
        atomic_text(self.config_path(eid).with_suffix(".yaml.bak"), old)
        self.record_config(eid, old, "before-save")
        atomic_text(self.config_path(eid), raw)
        self.record_config(eid, raw, "save", comment)
        if new_id != eid:
            try:
                self.folder(eid).rename(destination)
            except OSError:
                atomic_text(self.config_path(eid), old)
                raise ValueError("Could not move experiment files to the new URL path.")
        return self.read_config(new_id)

    def record_config(self, eid, raw, action, comment=''):
        with self.connect(eid) as db:
            last = db.execute("SELECT yaml FROM config_edits ORDER BY id DESC LIMIT 1").fetchone()
            if last and last[0] == raw and not comment:
                return
            db.execute("INSERT INTO config_edits (created_at,action,yaml,comment) VALUES (?,?,?,?)", (now(), action, raw, comment))

    def control_errors(self, eid):
        with self.connect(eid) as db:
            row=db.execute("SELECT value FROM metadata WHERE key='control_errors'").fetchone()
        return json.loads(row[0]) if row else []

    def retain_control_error(self, eid, op, message):
        errors=self.control_errors(eid)
        entry=next((item for item in errors if item['operation_id']==op['id']),None)
        if entry is None:
            entry={'operation_id':op['id'],'action':op['action'],'created_at':now(),'messages':[]}
            errors.append(entry)
        if message not in entry['messages']:entry['messages'].append(message)
        with self.connect(eid) as db:
            db.execute("INSERT OR REPLACE INTO metadata VALUES ('control_errors',?)",(json.dumps(errors),))

    def clear_control_errors(self, eid):
        with self.connect(eid) as db:
            db.execute("DELETE FROM metadata WHERE key='control_errors'")

    def clear_control_error(self, eid, operation_id):
        errors=[item for item in self.control_errors(eid) if item['operation_id']!=operation_id]
        with self.connect(eid) as db:
            db.execute("INSERT OR REPLACE INTO metadata VALUES ('control_errors',?)",(json.dumps(errors),))

    def comment_config_edit(self, eid, edit_id, comment):
        with self.connect(eid) as db:
            return db.execute('UPDATE config_edits SET comment=? WHERE id=?', (comment, edit_id)).rowcount == 1

    def config_edits(self, eid):
        with self.connect(eid) as db:
            return [dict(row) for row in db.execute("SELECT * FROM config_edits ORDER BY id DESC")]

    def archive(self, eid):
        trash = self.root / '.trash'
        trash.mkdir(exist_ok=True)
        self.folder(eid).rename(trash / (eid + '-' + uuid4().hex))

    def create(self, config):
        folder = self.folder(config.experiment.id)
        folder.mkdir(exist_ok=False)
        atomic_text(self.config_path(config.experiment.id),
                    yaml.safe_dump(config.model_dump(), allow_unicode=True, sort_keys=False))
        self.save_history(config.experiment.id, History())
        with self.connect(config.experiment.id):
            pass
        self.record_config(config.experiment.id, self.read_config(config.experiment.id)[1], "create")

    def ids(self):
        return sorted(p.name for p in self.root.iterdir()
                      if p.is_dir() and (p / "config/experiment.yaml").is_file())

    @contextmanager
    def connect(self, eid):
        db = self.folder(eid) / "db" / "experiment.sqlite3"
        db.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(db, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS config_edits (
            id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, action TEXT NOT NULL, yaml TEXT NOT NULL);
        INSERT OR IGNORE INTO metadata VALUES ('schema_version', '1');
        CREATE TABLE IF NOT EXISTS operations (
            id TEXT PRIMARY KEY, action TEXT NOT NULL, status TEXT NOT NULL,
            created_at TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY, runname TEXT NOT NULL, runnumber INTEGER NOT NULL,
            mode TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT,
            finished_at TEXT, data TEXT NOT NULL);
        """)
        if 'comment' not in {row[1] for row in conn.execute('PRAGMA table_info(config_edits)')}:
            conn.execute("ALTER TABLE config_edits ADD COLUMN comment TEXT NOT NULL DEFAULT ''")
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def read_history(self, eid):
        path = self.folder(eid) / "db" / "run_state.yaml"
        if not path.exists():
            return History()
        return History.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")))

    def save_history(self, eid, history):
        atomic_text(self.folder(eid) / "db" / "run_state.yaml",
                    yaml.safe_dump(history.model_dump(), allow_unicode=True, sort_keys=False))

    def remember(self, eid, state):
        history = self.read_history(eid)
        memory = RunMemory(name=state["runname"], current_number=state["runnumber"],
                           prev_header=state["header"])
        history.runs = [memory] + [r for r in history.runs if r.name != memory.name]
        self.save_history(eid, history)

    def put_operation(self, eid, op):
        with self.connect(eid) as db:
            db.execute("INSERT OR REPLACE INTO operations VALUES (?,?,?,?,?)",
                       (op["id"], op["action"], op["status"], op["created_at"], json.dumps(op, ensure_ascii=False)))

    def operations(self, eid, limit=30):
        with self.connect(eid) as db:
            rows = db.execute("SELECT data FROM operations ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def history_version(self, eid):
        with self.connect(eid) as db:
            op = db.execute("SELECT id,status FROM operations ORDER BY created_at DESC LIMIT 1").fetchone()
            run = db.execute("SELECT rowid,status FROM runs ORDER BY rowid DESC LIMIT 1").fetchone()
        return repr((tuple(op) if op else None, tuple(run) if run else None))

    def put_run(self, eid, run):
        with self.connect(eid) as db:
            rowid = run.get("_rowid")
            if rowid is None and run.get("id"):
                row = db.execute("SELECT rowid FROM runs WHERE id=?", (run["id"],)).fetchone()
                rowid = row[0] if row else None
            data = {k: v for k, v in run.items() if k not in ("id", "_rowid")}
            values = (run["runname"], run["runnumber"], run["mode"], run["status"],
                      run.get("started_at"), run.get("finished_at"), json.dumps(data, ensure_ascii=False))
            if rowid is None:
                cursor = db.execute("INSERT INTO runs (runname,runnumber,mode,status,started_at,finished_at,data) VALUES (?,?,?,?,?,?,?)", values)
                run["_rowid"] = cursor.lastrowid
            else:
                db.execute("UPDATE runs SET runname=?,runnumber=?,mode=?,status=?,started_at=?,finished_at=?,data=? WHERE rowid=?", (*values, rowid))
                run["_rowid"] = rowid
            run.pop("id", None)

    def runs(self, eid, limit=50, mode='all'):
        condition = " WHERE mode='nssta'" if mode == 'nssta' else " WHERE mode!='nssta'" if mode == 'saved' else ''
        with self.connect(eid) as db:
            rows = db.execute("SELECT rowid,data FROM runs" + condition + " ORDER BY rowid DESC LIMIT ?", (limit,)).fetchall()
        return [{**json.loads(row[1]), "_rowid": row[0]} for row in rows]

    def active_run(self, eid):
        with self.connect(eid) as db:
            row = db.execute("SELECT rowid,data FROM runs WHERE status IN ('running','unknown') ORDER BY rowid DESC LIMIT 1").fetchone()
        return {**json.loads(row[1]), "_rowid": row[0]} if row else None

    @staticmethod
    def public_run(run):
        # Read old records without retaining their duplicate snapshots or UUIDs.
        state = run.get("final_state") or run.get("start_state") or run.get("initial_state") or {}
        raw = run.get("daq_config") or state.get("raw_config") or {
            "runinfo": {"runname": run["runname"], "runnumber": run["runnumber"],
                        "header": run.get("header", ""), "startdate": run.get("started_at"),
                        "stopdate": run.get("finished_at")},
            "hdlist": state.get("hdlist", []), "eflist": state.get("ef_info", [])}
        return {"mode": run["mode"], "status": run["status"], "daq_config": raw,
                "event_num": run.get("event_num", state.get("event_num")),
                "es_event_num": run.get("es_event_num", state.get("es_event_num", {})),
                "config_snapshot": run.get("config_snapshot", {}),
                **({"error": run["error"]} if run.get("error") else {})}

    def recover_operations(self):
        for eid in self.ids():
            for op in self.operations(eid, limit=100000):
                if op["status"] in ("queued", "running"):
                    op.update(status="unknown", finished_at=now(),
                              message="Web backend restarted. Verify DAQ state and remote API results.")
                    self.put_operation(eid, op)
            for run in self.runs(eid, limit=100000):
                if run["status"] == "preparing":
                    run["status"] = "unknown"
                    run["error"] = "Backend restarted during Run preparation. Verify DAQ state."
                    self.put_run(eid, run)
