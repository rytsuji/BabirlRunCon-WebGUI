from typing import Literal, Optional
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Experiment(Strict):
    id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)


class EB(Strict):
    name: str = Field(min_length=1)
    host: str = Field(min_length=1)


class Endpoint(Strict):
    name: str = Field(min_length=1)
    api: str
    token_env: Optional[str] = None
    enabled: bool = True

    @field_validator("api")
    @classmethod
    def valid_url(cls, value):
        p = urlsplit(value)
        if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password or p.fragment:
            raise ValueError("http(s) URL without credentials or fragments is required")
        _ = p.port
        return value.rstrip("/")


class RunControlEndpoint(Endpoint):
    enable_nssta: bool = False
    event_poll_interval_sec: float = Field(default=2, ge=1, le=3600)
    start_timeout: float = Field(default=10, ge=1, le=3600)
    stop_timeout: float = Field(default=10, ge=1, le=3600)
    restart_enable_after_sec: float = Field(default=5,ge=1,le=3600)
    idle_connection_interval_sec: float = Field(default=2, ge=1, le=3600)


class QueryArgument(Strict):
    name: str = Field(pattern=r'^[A-Za-z_][A-Za-z0-9_]{0,63}$')
    source: Literal['runname','runnumber','header','event_num','start_time','stop_time','state','getconfig_json','run_history_json','current_run_json']

class Hook(Endpoint):
    run_on_nssta: bool = False
    send_query_params: bool = False
    argument_transport: Literal['query','json'] = 'query'
    query_params: list[QueryArgument] = Field(default_factory=list,max_length=32)

    @model_validator(mode='after')
    def unique_query_names(self):
        names=[item.name for item in self.query_params]
        if len(names)!=len(set(names)):raise ValueError('Query argument names must be unique within an API')
        return self


class MonitorEndpoint(Endpoint):
    interval_sec: float = Field(default=5,ge=1,le=3600)
    timeout_sec: float = Field(default=10,ge=1,le=3600)
    timing: Literal['always','running','idle'] = 'always'


class Babimo(Strict):
    efn: Optional[int] = Field(default=None,ge=0,le=255,strict=True)
    babinfo: bool = False
    babild: bool = False
    babissm: bool = False
    babian: bool = False

    def selected(self):
        return [name for name in ('babinfo','babild','babissm','babian') if getattr(self,name)]


class ExperimentConfig(Strict):
    experiment: Experiment
    eb: EB
    run_control_api: RunControlEndpoint
    restart_api: list[Endpoint] = Field(default_factory=list, max_length=100)
    start_api: list[Hook] = Field(default_factory=list, max_length=100)
    stop_api: list[Hook] = Field(default_factory=list, max_length=100)
    monitor_api: list[MonitorEndpoint] = Field(default_factory=list,max_length=100)
    babimo: Babimo = Field(default_factory=Babimo)

    @field_validator("restart_api", "start_api", "stop_api", "monitor_api", mode="before")
    @classmethod
    def empty_hooks(cls, value):
        # A YAML key with only comments is null, not an empty list.
        return [] if value is None else value

    @model_validator(mode="before")
    @classmethod
    def migrate_nssta(cls, value):
        # Accept older configuration files and stored Run snapshots.
        if isinstance(value, dict) and isinstance(value.get("eb"), dict) and "enable_nssta" in value["eb"]:
            value = dict(value)
            value["eb"] = dict(value["eb"])
            enabled = value["eb"].pop("enable_nssta")
            if isinstance(value.get("run_control_api"), dict):
                value["run_control_api"] = dict(value["run_control_api"])
                value["run_control_api"].setdefault("enable_nssta", enabled)
        return value


class RunMemory(Strict):
    name: str = Field(min_length=1, max_length=200)
    current_number: int = Field(ge=0)
    prev_header: str = Field(default="", max_length=4000)


class History(Strict):
    runs: list[RunMemory] = Field(default_factory=list)


class LiveState(Strict):
    state: Literal["stopped", "running", "nssta", "unknown"]
    runname: str
    runnumber: int = Field(ge=0)
    header: str = ""
    event_num: Optional[int] = None
    start_time: Optional[str] = None
    stop_time: Optional[str] = None
    hdlist: list = Field(default_factory=list)
    ef_info: list = Field(default_factory=list)
    es_event_num: dict = Field(default_factory=dict)
    raw_config: dict = Field(default_factory=dict)
    acquisition_errors: dict = Field(default_factory=dict)
    target: dict = Field(default_factory=dict)


class ServerConfig(Strict):
    host: str = "127.0.0.1"
    port: int = Field(default=8080, ge=1, le=65535)
    experiments_dir: str = "experiments"
    controller: Literal["http"] = "http"
    request_timeout_sec: float = Field(default=5, gt=0)
    operation_timeout_sec: float = Field(default=600, gt=0)
