import { useEffect, useRef, useState, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams } from "react-router-dom";

// ── Types ─────────────────────────────────────────────────────────────────
type User = { id: string; email: string; role: string };
type ProjectStatus = "idle" | "building" | "live" | "failed" | "stopped";
type Project = {
  id: string; name: string; repo: string; branch: string;
  buildCommand: string; startCommand: string; volumePath: string;
  port: number; env: Record<string, string>; status: ProjectStatus;
  domain?: string; customDomain?: string;
  containerId?: string; imageTag?: string; webhookSecret?: string;
  memoryLimit?: string; cpus?: string; notifyUrl?: string;
  autoDeployEnabled: boolean;
  createdAt: number; updatedAt: number;
  latestDeployment?: Deployment | null;
};
type DeployStatus = "queued" | "building" | "live" | "failed" | "cancelled";
type Deployment = {
  id: string; projectId: string; commitSha: string;
  triggeredBy: "manual" | "webhook" | "rollback";
  status: DeployStatus; imageTag: string;
  logs: string[]; createdAt: number; finishedAt?: number;
  projectName?: string;
};
type ContainerStats = {
  cpu: string; memUsage: string; memLimit: string;
  memPercent: string; netIn: string; netOut: string; pids: string;
} | null;

// ── API ────────────────────────────────────────────────────────────────────
const getToken = () => localStorage.getItem("nexus-token") ?? "";
const authH = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` });
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...authH(), ...(init?.headers ?? {}) } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data as T;
}

// ── Utils ──────────────────────────────────────────────────────────────────
function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}
function duration(a: number, b?: number) {
  const ms = (b ?? Date.now()) - a;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
function classifyLine(line: string) {
  if (/✅|✓|success/i.test(line)) return "success";
  if (/✗|error|Error|failed|fatal/i.test(line)) return "error";
  if (line.startsWith("[nexus]")) return "info";
  if (/warn/i.test(line)) return "warn";
  return "";
}
const triggerIcon: Record<string, string> = { manual: "⬡", webhook: "⚡", rollback: "↩", cancelled: "✕" };

// ── Badge ──────────────────────────────────────────────────────────────────
function Badge({ status }: { status: string }) {
  const s = status === "cancelled" ? "failed" : status;
  return <span className={`badge badge-${s}`}>{status}</span>;
}
function TriggerPill({ by }: { by: string }) {
  return <span style={{ fontSize: "0.72rem", color: "var(--muted)" }}>{triggerIcon[by] ?? "·"} {by}</span>;
}

// ── Login ──────────────────────────────────────────────────────────────────
function Login({ onAuthed }: { onAuthed: (token: string, user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState(""); const [pw, setPw] = useState("");
  const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  async function submit() {
    setError(""); setLoading(true);
    try {
      const d = await api<{ token: string; user: User }>(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify({ email, password: pw }) });
      localStorage.setItem("nexus-token", d.token); onAuthed(d.token, d.user);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }
  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-logo">⬡ nexus-deploy</div>
        <h1 className="login-title">Ship anything, free forever.</h1>
        <p className="login-sub">Self-hosted deployment by The No Hands Company. No billing. No lock-in.</p>
        <div className="login-tabs">
          <button className={`login-tab ${mode === "login" ? "active" : ""}`} onClick={() => setMode("login")}>Sign in</button>
          <button className={`login-tab ${mode === "register" ? "active" : ""}`} onClick={() => setMode("register")}>Create account</button>
        </div>
        <div className="form-group"><label>Email</label><input type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} /></div>
        <div className="form-group"><label>Password</label><input type="password" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} /></div>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary" style={{ width: "100%", marginTop: "0.5rem" }} onClick={submit} disabled={loading}>
          {loading ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </div>
    </div>
  );
}

// ── New project modal ──────────────────────────────────────────────────────
function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }) {
  const [f, setF] = useState({ name: "", repo: "", branch: "main", port: "3000", buildCommand: "npm run build", startCommand: "npm start", volumePath: "/workspace" });
  const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF(v => ({ ...v, [k]: e.target.value }));
  async function submit() {
    setError(""); setLoading(true);
    try { const d = await api<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify({ ...f, port: Number(f.port) }) }); onCreated(d.project); }
    catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }
  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>New project</h2>
        <div className="form-row">
          <div className="form-group"><label>Project name</label><input value={f.name} onChange={set("name")} placeholder="my-app" /></div>
          <div className="form-group"><label>Branch</label><input value={f.branch} onChange={set("branch")} /></div>
        </div>
        <div className="form-group"><label>GitHub repo</label><input value={f.repo} onChange={set("repo")} placeholder="owner/repo  or  https://github.com/owner/repo" /></div>
        <div className="form-row">
          <div className="form-group"><label>Build command</label><input value={f.buildCommand} onChange={set("buildCommand")} /></div>
          <div className="form-group"><label>Start command</label><input value={f.startCommand} onChange={set("startCommand")} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label>Volume path</label><input value={f.volumePath} onChange={set("volumePath")} /></div>
          <div className="form-group"><label>Port</label><input value={f.port} onChange={set("port")} type="number" placeholder="3000" /></div>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={loading}>{loading ? "Creating…" : "Create project"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Log terminal ───────────────────────────────────────────────────────────
function LogTerminal({ wsPath, live, label }: { wsPath: string; live: boolean; label?: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setLines([]); setDone(false);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}${wsPath}`);
    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "log" || msg.type === "info" || msg.type === "error") setLines(l => [...l.slice(-800), msg.line]);
        if (msg.type === "done") setDone(true);
      } catch {}
    };
    return () => ws.close();
  }, [wsPath]);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  return (
    <div className="terminal">
      <div className="terminal-bar">
        <div className="terminal-dot red" /><div className="terminal-dot yellow" /><div className="terminal-dot green" />
        <span className="terminal-label" style={{ color: live && !done ? "var(--warn)" : "var(--live)" }}>
          {label ?? (live && !done ? "● building" : "● done")}
        </span>
      </div>
      <div className="terminal-body" ref={ref}>
        {lines.length === 0 && <span className="log-line text-muted">Connecting…</span>}
        {lines.map((line, i) => <span key={i} className={`log-line ${classifyLine(line)}`}>{line + "\n"}</span>)}
        {live && !done && <span className="log-cursor" />}
      </div>
    </div>
  );
}

// ── Env editor with file import ────────────────────────────────────────────
function EnvEditor({ projectId, initial, onSaved }: { projectId: string; initial: Record<string, string>; onSaved: () => void }) {
  const [pairs, setPairs] = useState(() => Object.entries(initial).map(([k, v]) => ({ k, v })));
  const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(false);
  const [importText, setImportText] = useState(""); const [showImport, setShowImport] = useState(false);

  function parseEnvFile(text: string) {
    const parsed: { k: string; v: string }[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      parsed.push({ k, v });
    }
    return parsed;
  }

  function importEnv() {
    const parsed = parseEnvFile(importText);
    if (!parsed.length) return;
    setPairs(existing => {
      const map = new Map(existing.map(p => [p.k, p.v]));
      parsed.forEach(p => map.set(p.k, p.v));
      return Array.from(map.entries()).map(([k, v]) => ({ k, v }));
    });
    setImportText(""); setShowImport(false);
  }

  async function save() {
    setSaving(true); setSaved(false);
    await api(`/api/projects/${projectId}/env`, { method: "PUT", body: JSON.stringify({ env: Object.fromEntries(pairs.filter(p => p.k).map(p => [p.k, p.v])) }) });
    setSaving(false); setSaved(true); onSaved(); setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div>
      {pairs.map((pair, i) => (
        <div className="env-row" key={i}>
          <input placeholder="KEY" value={pair.k} onChange={e => setPairs(p => p.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
          <input placeholder="value" value={pair.v} onChange={e => setPairs(p => p.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} />
          <button className="env-del-btn" onClick={() => setPairs(p => p.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}

      {showImport && (
        <div style={{ marginTop: "0.75rem", marginBottom: "0.75rem" }}>
          <textarea
            value={importText}
            onChange={e => setImportText(e.target.value)}
            placeholder={"Paste .env file contents here:\n\nKEY=value\nANOTHER_KEY=another_value\n# Comments are ignored"}
            style={{ width: "100%", minHeight: 140, padding: "0.65rem", borderRadius: 8, border: "1px solid var(--border2)", background: "rgba(255,255,255,0.03)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: "0.82rem", resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <button className="btn btn-primary btn-sm" onClick={importEnv}>Import {parseEnvFile(importText).length} variable{parseEnvFile(importText).length !== 1 ? "s" : ""}</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowImport(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: "0.6rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setPairs(p => [...p, { k: "", v: "" }])}>+ Add variable</button>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowImport(s => !s)}>⬆ Import .env file</button>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>{saving ? "Saving…" : saved ? "✓ Saved" : "Save changes"}</button>
      </div>
    </div>
  );
}

// ── Webhook panel ──────────────────────────────────────────────────────────
function WebhookPanel({ project, onRegen }: { project: Project; onRegen: () => void }) {
  const [regen, setRegen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const webhookUrl = `${location.origin}/api/webhooks/github/${project.id}`;
  function copy(text: string, which: string) { navigator.clipboard.writeText(text); setCopied(which); setTimeout(() => setCopied(null), 2000); }
  async function regenSecret() { setRegen(true); await api(`/api/projects/${project.id}/regen-webhook-secret`, { method: "POST", body: "{}" }); onRegen(); setRegen(false); }
  return (
    <div className="card">
      <div className="card-header"><h3>GitHub webhook</h3></div>
      <div className="card-body">
        <p style={{ fontSize: "0.83rem", color: "var(--muted)", marginBottom: "1.25rem", lineHeight: 1.6 }}>
          Add under your repo <strong>Settings → Webhooks → Add webhook</strong>. Content type: <code style={{ background: "rgba(255,255,255,0.07)", padding: "1px 6px", borderRadius: 4 }}>application/json</code>. Event: <strong>push</strong>.
        </p>
        <div className="form-group"><label>Payload URL</label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input readOnly value={webhookUrl} style={{ flex: 1 }} />
            <button className="btn btn-ghost btn-sm" onClick={() => copy(webhookUrl, "url")}>{copied === "url" ? "✓" : "Copy"}</button>
          </div>
        </div>
        <div className="form-group"><label>Secret</label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input readOnly value={project.webhookSecret ?? "—"} style={{ flex: 1, fontFamily: "var(--mono)", fontSize: "0.8rem" }} />
            <button className="btn btn-ghost btn-sm" onClick={() => copy(project.webhookSecret ?? "", "secret")}>{copied === "secret" ? "✓" : "Copy"}</button>
            <button className="btn btn-ghost btn-sm" onClick={regenSecret} disabled={regen} title="Regenerate">↺</button>
          </div>
          <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.3rem" }}>Regenerating invalidates the old secret immediately.</p>
        </div>
      </div>
    </div>
  );
}

// ── Project detail ─────────────────────────────────────────────────────────
type DetailTab = "overview" | "logs" | "runtime" | "env" | "webhook" | "settings";

function ProjectDetail({ token }: { token: string }) {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [activeDepId, setActiveDepId] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<ContainerStats>(null);
  const [containerWsKey, setContainerWsKey] = useState(0);
  const [sf, setSf] = useState({ repo: "", branch: "", buildCommand: "", startCommand: "", port: "3000", customDomain: "", memoryLimit: "", cpus: "", notifyUrl: "", autoDeployEnabled: true });
  const [sfSaved, setSfSaved] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const d = await api<{ project: Project; deployments: Deployment[] }>(`/api/projects/${id}`);
    setProject(d.project); setDeployments(d.deployments);
    setSf({ repo: d.project.repo, branch: d.project.branch, buildCommand: d.project.buildCommand, startCommand: d.project.startCommand, port: String(d.project.port ?? 3000), customDomain: d.project.customDomain ?? "", memoryLimit: d.project.memoryLimit ?? "", cpus: d.project.cpus ?? "", notifyUrl: d.project.notifyUrl ?? "", autoDeployEnabled: d.project.autoDeployEnabled ?? true });
    if (!activeDepId && d.deployments.length) setActiveDepId(d.deployments[0].id);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Poll when building
  useEffect(() => {
    if (project?.status !== "building") return;
    const t = setInterval(load, 3000); return () => clearInterval(t);
  }, [project?.status, load]);

  // Stats polling — proper top-level effect, conditional inside
  useEffect(() => {
    if (tab !== "runtime" || !project || project.status !== "live") return;
    const fetchStats = () =>
      api<{ stats: ContainerStats }>(`/api/projects/${project.id}/stats`)
        .then(d => setStats(d.stats)).catch(() => {});
    fetchStats();
    const t = setInterval(fetchStats, 5000);
    return () => clearInterval(t);
  }, [tab, project?.status, project?.id]);

  async function deploy() {
    if (!project) return;
    setDeploying(true); setError("");
    try {
      const d = await api<{ deployment: Deployment }>(`/api/projects/${project.id}/deploy`, { method: "POST", body: JSON.stringify({ commitSha: "manual" }) });
      setActiveDepId(d.deployment.id); setTab("logs"); await load();
    } catch (e: any) { setError(e.message); } finally { setDeploying(false); }
  }

  async function cancelDeploy() {
    if (!activeDepId) return;
    setCancelling(true);
    try { await api(`/api/deployments/${activeDepId}/cancel`, { method: "POST", body: "{}" }); await load(); }
    catch (e: any) { setError(e.message); } finally { setCancelling(false); }
  }

  async function rollback(depId: string) {
    const d = await api<{ deployment: Deployment }>(`/api/deployments/${depId}/rollback`, { method: "POST", body: "{}" });
    setActiveDepId(d.deployment.id); setTab("logs"); await load();
  }

  async function restart() {
    if (!project) return;
    setRestarting(true);
    try { await api(`/api/projects/${project.id}/restart`, { method: "POST", body: "{}" }); await load(); }
    catch (e: any) { setError(e.message); } finally { setRestarting(false); }
  }

  async function stopStart() {
    if (!project) return;
    await api(`/api/projects/${project.id}/${project.status === "live" ? "stop" : "start"}`, { method: "POST", body: "{}" });
    await load();
  }

  async function deleteProject() {
    if (!project || !confirm(`Delete ${project.name}? Cannot be undone.`)) return;
    await api(`/api/projects/${project.id}`, { method: "DELETE" });
    nav("/");
  }

  async function saveSettings() {
    if (!project) return;
    await api(`/api/projects/${project.id}`, { method: "PUT", body: JSON.stringify({ ...sf, port: Number(sf.port), customDomain: sf.customDomain || undefined, memoryLimit: sf.memoryLimit || "", cpus: sf.cpus || "", notifyUrl: sf.notifyUrl || "", autoDeployEnabled: sf.autoDeployEnabled }) });
    setSfSaved(true); setTimeout(() => setSfSaved(false), 2500); await load();
  }

  if (!project) return <div className="loading"><div className="spinner" /> Loading…</div>;

  const activeDep = deployments.find(d => d.id === activeDepId);
  const building = project.status === "building";
  const liveUrl = `https://${project.customDomain ?? project.domain ?? `${project.name}.your-domain.com`}`;
  const activeBuildDep = deployments.find(d => d.status === "building" || d.status === "queued");

  return (
    <div className="page">
      {/* Header */}
      <div className="detail-header">
        <div className="detail-header-info">
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <button className="btn btn-ghost btn-sm" onClick={() => nav("/")}>←</button>
            <h1>{project.name}</h1>
            <Badge status={project.status} />
            {!project.autoDeployEnabled && <span className="badge badge-idle">auto-deploy off</span>}
          </div>
          <div className="detail-repo" style={{ marginTop: 4 }}>{project.repo} · {project.branch} · :{project.port}</div>
          {(project.customDomain ?? project.domain) && (
            <a href={liveUrl} target="_blank" rel="noreferrer" className="project-domain" style={{ display: "inline-block", marginTop: 4 }}>{liveUrl} ↗</a>
          )}
        </div>
        <div className="detail-header-actions">
          {error && <span style={{ color: "var(--danger)", fontSize: "0.82rem" }}>{error}</span>}
          {building && activeBuildDep && (
            <button className="btn btn-danger btn-sm" onClick={cancelDeploy} disabled={cancelling}>
              {cancelling ? "Cancelling…" : "✕ Cancel"}
            </button>
          )}
          {project.status === "live" && <button className="btn btn-ghost btn-sm" onClick={stopStart}>⏹ Stop</button>}
          {project.status === "live" && <button className="btn btn-ghost btn-sm" onClick={restart} disabled={restarting}>{restarting ? "↺…" : "↺ Restart"}</button>}
          {project.status === "stopped" && <button className="btn btn-ghost btn-sm" onClick={stopStart}>▶ Start</button>}
          <button className="btn btn-primary btn-sm" onClick={deploy} disabled={deploying || building}>
            {deploying || building ? <><div className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} /> Building…</> : "↑ Deploy"}
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="stats-row">
        {[
          { label: "Deployments", value: String(deployments.length) },
          { label: "Last deploy", value: deployments[0] ? timeAgo(deployments[0].createdAt) : "Never" },
          { label: "Duration", value: deployments[0]?.finishedAt ? duration(deployments[0].createdAt, deployments[0].finishedAt) : "—" },
          { label: "Env vars", value: String(Object.keys(project.env).length) },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <div className="stat-label">{s.label}</div>
            <div className="stat-value">{s.value}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="tabs">
        {([
          ["overview", "⬡ Overview"],
          ["logs", "▶ Build logs"],
          ["runtime", "🖥 Runtime"],
          ["env", "⚙ Environment"],
          ["webhook", "⚡ Webhook"],
          ["settings", "✎ Settings"],
        ] as const).map(([t, label]) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`}
            onClick={() => { setTab(t); if (t === "runtime") setContainerWsKey(k => k + 1); }}>
            {label}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === "overview" && (
        <div className="card">
          <div className="card-header"><h3>Deployment history</h3></div>
          <div className="card-body no-pad">
            {deployments.length === 0 && <div className="empty"><div className="empty-icon">🚀</div><p>No deployments yet.</p></div>}
            <div className="deployment-list">
              {deployments.map(dep => (
                <div key={dep.id} className="deployment-row">
                  <Badge status={dep.status} />
                  <span className="deployment-sha" style={{ cursor: "pointer" }}
                    onClick={() => { setActiveDepId(dep.id); setTab("logs"); }}>{dep.commitSha.slice(0, 10)}</span>
                  <div className="deployment-meta" style={{ flex: 1 }}><TriggerPill by={dep.triggeredBy} /></div>
                  <span className="deployment-time">{dep.finishedAt ? duration(dep.createdAt, dep.finishedAt) : (dep.status === "building" ? "building…" : "—")}</span>
                  <span className="deployment-time">{timeAgo(dep.createdAt)}</span>
                  {dep.imageTag && dep.status === "live" && dep.id !== deployments.find(d => d.status === "live")?.id && (
                    <button className="btn btn-ghost btn-sm" onClick={() => rollback(dep.id)} title="Rollback">↩</button>
                  )}
                  {(dep.status === "building" || dep.status === "queued") && (
                    <button className="btn btn-danger btn-sm" onClick={async () => {
                      await api(`/api/deployments/${dep.id}/cancel`, { method: "POST", body: "{}" }); load();
                    }}>✕</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Build logs */}
      {tab === "logs" && (
        <div>
          {deployments.length > 1 && (
            <div style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Deployment:</span>
              <select style={{ background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border2)", borderRadius: 7, padding: "0.3rem 0.6rem", fontFamily: "var(--mono)", fontSize: "0.8rem" }}
                value={activeDepId ?? ""} onChange={e => setActiveDepId(e.target.value)}>
                {deployments.map(d => <option key={d.id} value={d.id}>{d.commitSha.slice(0, 10)} — {d.status} — {timeAgo(d.createdAt)}</option>)}
              </select>
            </div>
          )}
          {activeDepId
            ? <LogTerminal wsPath={`/api/log-stream?deploymentId=${activeDepId}&token=${token}`} live={activeDep?.status === "building" || activeDep?.status === "queued"} />
            : <div className="empty"><div className="empty-icon">▶</div><p>No deployment selected.</p></div>}
        </div>
      )}

      {/* Runtime */}
      {tab === "runtime" && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
            <p style={{ fontSize: "0.83rem", color: "var(--muted)" }}>Live stdout/stderr from your running container.</p>
            <button className="btn btn-ghost btn-sm" onClick={() => setContainerWsKey(k => k + 1)}>↺ Reconnect</button>
          </div>
          {stats && project.status === "live" && (
            <div className="stats-row" style={{ marginBottom: "1rem" }}>
              {[
                { label: "CPU", value: stats.cpu },
                { label: "Memory", value: `${stats.memUsage} (${stats.memPercent})` },
                { label: "Net ↓", value: stats.netIn },
                { label: "Net ↑", value: stats.netOut },
                { label: "PIDs", value: stats.pids },
              ].map(s => (
                <div key={s.label} className="stat-card" style={{ minWidth: 0, flex: 1 }}>
                  <div className="stat-label">{s.label}</div>
                  <div className="stat-value" style={{ fontSize: "0.88rem" }}>{s.value}</div>
                </div>
              ))}
            </div>
          )}
          {project.status === "live" || project.status === "building"
            ? <LogTerminal key={containerWsKey} wsPath={`/api/container-stream?projectId=${project.id}&token=${token}`} live={true} label={project.status === "live" ? "● streaming" : "● starting…"} />
            : <div className="empty"><div className="empty-icon">🖥</div><p>Container is {project.status}. Start it to stream logs.</p></div>}
        </div>
      )}

      {/* Environment */}
      {tab === "env" && (
        <div className="card">
          <div className="card-header"><h3>Environment variables</h3></div>
          <div className="card-body">
            <p style={{ fontSize: "0.82rem", color: "var(--muted)", marginBottom: "1.25rem" }}>
              Injected at runtime. Redeploy to apply changes. You can also import a <code style={{ background: "rgba(255,255,255,0.07)", padding: "1px 5px", borderRadius: 4 }}>.env</code> file.
            </p>
            <EnvEditor projectId={project.id} initial={project.env} onSaved={load} />
          </div>
        </div>
      )}

      {/* Webhook */}
      {tab === "webhook" && <WebhookPanel project={project} onRegen={load} />}

      {/* Settings */}
      {tab === "settings" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div className="card">
            <div className="card-header"><h3>Project settings</h3></div>
            <div className="card-body">
              <div className="form-group"><label>Repository</label><input value={sf.repo} onChange={e => setSf(f => ({ ...f, repo: e.target.value }))} /></div>
              <div className="form-row">
                <div className="form-group"><label>Branch</label><input value={sf.branch} onChange={e => setSf(f => ({ ...f, branch: e.target.value }))} /></div>
                <div className="form-group"><label>Port</label><input type="number" value={sf.port} onChange={e => setSf(f => ({ ...f, port: e.target.value }))} /></div>
              </div>
              <div className="form-row">
                <div className="form-group"><label>Build command</label><input value={sf.buildCommand} onChange={e => setSf(f => ({ ...f, buildCommand: e.target.value }))} /></div>
                <div className="form-group"><label>Start command</label><input value={sf.startCommand} onChange={e => setSf(f => ({ ...f, startCommand: e.target.value }))} /></div>
              </div>
              <div className="form-group"><label>Custom domain</label>
                <input value={sf.customDomain} onChange={e => setSf(f => ({ ...f, customDomain: e.target.value }))} placeholder="app.yourdomain.com — CNAME to your server, then redeploy" />
              </div>
              <div className="form-row">
                <div className="form-group"><label>Memory limit</label><input value={sf.memoryLimit} onChange={e => setSf(f => ({ ...f, memoryLimit: e.target.value }))} placeholder="512m  or  1g  (blank = unlimited)" /></div>
                <div className="form-group"><label>CPU limit</label><input value={sf.cpus} onChange={e => setSf(f => ({ ...f, cpus: e.target.value }))} placeholder="0.5  or  2  (blank = unlimited)" /></div>
              </div>
              <div className="form-group"><label>Notify URL</label>
                <input value={sf.notifyUrl} onChange={e => setSf(f => ({ ...f, notifyUrl: e.target.value }))} placeholder="https://hooks.slack.com/... or https://discord.com/api/webhooks/..." />
                <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.3rem" }}>POST on every deploy success or failure. Discord webhooks auto-detected.</p>
              </div>
              <div className="form-group">
                <label style={{ display: "flex", alignItems: "center", gap: "0.6rem", cursor: "pointer", textTransform: "none", letterSpacing: 0 }}>
                  <input type="checkbox" checked={sf.autoDeployEnabled} onChange={e => setSf(f => ({ ...f, autoDeployEnabled: e.target.checked }))}
                    style={{ width: 16, height: 16, cursor: "pointer" }} />
                  <span style={{ fontSize: "0.88rem", fontWeight: 500 }}>Auto-deploy on push</span>
                </label>
                <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.3rem", marginLeft: "1.6rem" }}>When disabled, GitHub webhooks are accepted but builds are not triggered.</p>
              </div>
              <div className="form-actions">
                <button className="btn btn-primary btn-sm" onClick={saveSettings}>{sfSaved ? "✓ Saved" : "Save settings"}</button>
              </div>
            </div>
          </div>
          <div className="card" style={{ borderColor: "rgba(244,63,94,0.2)" }}>
            <div className="card-header"><h3 style={{ color: "var(--danger)" }}>Danger zone</h3></div>
            <div className="card-body" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.88rem" }}>Delete this project</div>
                <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: 2 }}>Stops the container and removes all history.</div>
              </div>
              <button className="btn btn-danger btn-sm" onClick={deleteProject}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Activity feed ──────────────────────────────────────────────────────────
function ActivityFeed() {
  const nav = useNavigate();
  const [activity, setActivity] = useState<any[]>([]);
  useEffect(() => {
    const load = () => api<{ activity: any[] }>("/api/activity").then(d => setActivity(d.activity)).catch(() => {});
    load(); const t = setInterval(load, 15_000); return () => clearInterval(t);
  }, []);
  if (!activity.length) return null;
  return (
    <div className="card" style={{ marginTop: "1.5rem" }}>
      <div className="card-header"><h3>Recent activity</h3></div>
      <div className="card-body no-pad">
        <div className="deployment-list">
          {activity.map(ev => (
            <div key={ev.id} className="deployment-row" style={{ cursor: "pointer" }} onClick={() => nav(`/projects/${ev.projectId}`)}>
              <Badge status={ev.status} />
              <span className="deployment-sha text-mono">{ev.projectName}</span>
              <div className="deployment-meta" style={{ flex: 1 }}><TriggerPill by={ev.triggeredBy} /></div>
              {ev.finishedAt && <span className="deployment-time">{duration(ev.createdAt, ev.finishedAt)}</span>}
              <span className="deployment-time">{timeAgo(ev.createdAt)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Projects list ──────────────────────────────────────────────────────────
function ProjectsList() {
  const nav = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    const d = await api<{ projects: Project[] }>("/api/projects");
    setProjects(d.projects); setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // SSE for instant status updates
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    es.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "status")
          setProjects(ps => ps.map(p => p.id === msg.projectId ? { ...p, status: msg.status } : p));
      } catch {}
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, []);

  // Fallback poll while building
  useEffect(() => {
    if (!projects.some(p => p.status === "building")) return;
    const t = setInterval(load, 5000); return () => clearInterval(t);
  }, [projects, load]);

  const filtered = search.trim()
    ? projects.filter(p => p.name.includes(search.toLowerCase()) || p.repo.toLowerCase().includes(search.toLowerCase()))
    : projects;

  const counts = { live: projects.filter(p => p.status === "live").length, building: projects.filter(p => p.status === "building").length, failed: projects.filter(p => p.status === "failed").length };

  return (
    <div className="page">
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <h1>Projects</h1>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginTop: 4 }}>
            {projects.length} project{projects.length !== 1 ? "s" : ""}
            {counts.live > 0 && <span style={{ color: "var(--live)", marginLeft: "0.75rem" }}>● {counts.live} live</span>}
            {counts.building > 0 && <span style={{ color: "var(--warn)", marginLeft: "0.75rem" }}>● {counts.building} building</span>}
            {counts.failed > 0 && <span style={{ color: "var(--danger)", marginLeft: "0.75rem" }}>● {counts.failed} failed</span>}
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
          {projects.length > 3 && (
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search projects…"
              style={{ padding: "0.5rem 0.75rem", borderRadius: 8, border: "1px solid var(--border2)", background: "rgba(255,255,255,0.04)", color: "var(--text)", fontFamily: "var(--mono)", fontSize: "0.82rem", width: 200 }} />
          )}
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New project</button>
        </div>
      </div>

      {loading && <div className="empty" style={{ padding: "3rem" }}><div className="spinner" /></div>}
      {!loading && projects.length === 0 && (
        <div className="empty">
          <div className="empty-icon">⬡</div>
          <p>No projects yet. Create one and ship something.</p>
          <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>+ New project</button>
        </div>
      )}
      {!loading && search && filtered.length === 0 && (
        <div className="empty"><div className="empty-icon">🔍</div><p>No projects match "{search}"</p></div>
      )}

      <div className="projects-grid">
        {filtered.map(p => (
          <div key={p.id} className="project-card" onClick={() => nav(`/projects/${p.id}`)}>
            <div className="project-card-top">
              <div>
                <div className="project-name">{p.name}</div>
                <div className="project-repo">{p.repo} · {p.branch}</div>
              </div>
              <Badge status={p.status} />
            </div>
            {(p.customDomain ?? p.domain) && <div className="project-domain">https://{p.customDomain ?? p.domain}</div>}
            <div className="project-card-meta">
              <span>{p.latestDeployment ? `${timeAgo(p.latestDeployment.createdAt)} · ${p.latestDeployment.triggeredBy}` : "No deploys yet"}</span>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                {!p.autoDeployEnabled && <span style={{ fontSize: "0.68rem", color: "var(--muted)", border: "1px solid var(--border2)", borderRadius: 4, padding: "1px 5px" }}>manual</span>}
                <span>:{p.port}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <ActivityFeed />
      {showNew && <NewProjectModal onClose={() => setShowNew(false)} onCreated={proj => { setShowNew(false); nav(`/projects/${proj.id}`); }} />}
    </div>
  );
}

// ── Network Health ─────────────────────────────────────────────────────────
const NETWORK_API = (import.meta as any).env?.VITE_NEXUS_NETWORK_API
  ?? "https://network.nexus.computer/api/stats";

function NetworkHealth() {
  const [stats, setStats] = React.useState<{ nodes_online: number; total_ram_gb: number; countries: number; compute_jobs_hour: number } | null>(null);
  useEffect(() => {
    const load = () => fetch(NETWORK_API).then(r => r.json()).then(setStats).catch(() => {});
    load(); const t = setInterval(load, 30_000); return () => clearInterval(t);
  }, []);
  if (!stats) return null;
  const ramTb = stats.total_ram_gb >= 1024 ? (stats.total_ram_gb / 1024).toFixed(1) + " TB" : Math.round(stats.total_ram_gb) + " GB";
  return (
    <div style={{ margin: "0.75rem 0", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border2)", background: "rgba(255,255,255,0.02)", fontSize: "0.75rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 7 }}>
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--live)", display: "inline-block" }} />
        <span style={{ color: "var(--live)", fontWeight: 600, letterSpacing: "0.02em" }}>Nexus Network</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 8px", color: "var(--muted)" }}>
        <span>Nodes <span style={{ color: "var(--text)" }}>{stats.nodes_online.toLocaleString()}</span></span>
        <span>RAM <span style={{ color: "var(--text)" }}>{ramTb}</span></span>
        <span>Compute <span style={{ color: "var(--warn)" }}>{stats.compute_jobs_hour.toLocaleString()}</span></span>
        <span>Countries <span style={{ color: "var(--text)" }}>{stats.countries}</span></span>
      </div>
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────
function Sidebar({ user, onLogout }: { user: User; onLogout: () => void }) {
  const nav = useNavigate();
  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="wordmark">⬡ nexus-deploy</div>
        <div className="sub">The No Hands Company</div>
      </div>
      <nav className="sidebar-nav">
        <button className="nav-link active" onClick={() => nav("/")}><span className="icon">⬡</span> Projects</button>
        <button className="nav-link" onClick={() => window.open("https://github.com/The-No-Hands-company/Nexus-Deploy", "_blank")}><span className="icon">↗</span> GitHub</button>
      </nav>
      <NetworkHealth />
      <div className="sidebar-user">
        <div className="role-badge">{user.role}</div>
        <div className="email">{user.email}</div>
        <button className="logout-btn" onClick={onLogout}>Sign out</button>
      </div>
    </aside>
  );
}

// ── App ────────────────────────────────────────────────────────────────────
function AppShell({ token, user, onLogout }: { token: string; user: User; onLogout: () => void }) {
  return (
    <div className="shell">
      <Sidebar user={user} onLogout={onLogout} />
      <main className="main">
        <Routes>
          <Route path="/" element={<ProjectsList />} />
          <Route path="/projects/:id" element={<ProjectDetail token={token} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("nexus-token"));
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!token) { setChecking(false); return; }
    fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { setUser(d.user); setChecking(false); })
      .catch(() => { setToken(null); setChecking(false); });
  }, [token]);

  function logout() { localStorage.removeItem("nexus-token"); setToken(null); setUser(null); }

  if (checking) return <div className="loading"><div className="spinner" /> Nexus Deploy</div>;
  if (!token || !user) return <BrowserRouter><Login onAuthed={(t, u) => { setToken(t); setUser(u); }} /></BrowserRouter>;
  return <BrowserRouter><AppShell token={token} user={user} onLogout={logout} /></BrowserRouter>;
}
