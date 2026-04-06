import { useEffect, useRef, useState, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useParams } from "react-router-dom";

// ── Types ─────────────────────────────────────────────────────────────────
type User = { id: string; email: string; role: string };
type ProjectStatus = "idle" | "building" | "live" | "failed" | "stopped";
type Project = {
  id: string; name: string; repo: string; branch: string;
  buildCommand: string; startCommand: string; volumePath: string;
  env: Record<string, string>; status: ProjectStatus;
  domain?: string; containerId?: string; imageTag?: string;
  createdAt: number; updatedAt: number;
  latestDeployment?: Deployment | null;
};
type DeployStatus = "queued" | "building" | "live" | "failed";
type Deployment = {
  id: string; projectId: string; commitSha: string;
  triggeredBy: "manual" | "webhook"; status: DeployStatus;
  imageTag: string; logs: string[]; createdAt: number; finishedAt?: number;
};

// ── API helpers ───────────────────────────────────────────────────────────
const getToken = () => localStorage.getItem("nexus-token") ?? "";
const authHeaders = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${getToken()}`,
});

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...authHeaders(), ...(init?.headers ?? {}) } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data as T;
}

// ── Utils ─────────────────────────────────────────────────────────────────
function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function classifyLine(line: string) {
  if (line.includes("✅") || line.includes("✓") || line.includes("success")) return "success";
  if (line.includes("✗") || line.includes("error") || line.includes("Error") || line.includes("failed")) return "error";
  if (line.startsWith("[nexus]")) return "info";
  if (line.includes("warn") || line.includes("WARN")) return "warn";
  return "";
}

// ── Status badge ──────────────────────────────────────────────────────────
function Badge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

// ── Login page ─────────────────────────────────────────────────────────────
function Login({ onAuthed }: { onAuthed: (token: string, user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    setError(""); setLoading(true);
    try {
      const data = await api<{ token: string; user: User }>(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      localStorage.setItem("nexus-token", data.token);
      onAuthed(data.token, data.user);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <div className="login-logo">⬡ nexus-deploy</div>
        <h1 className="login-title">Ship anything, free forever.</h1>
        <p className="login-sub">Self-hosted deployment by The No Hands Company.</p>
        <div className="login-tabs">
          <button className={`login-tab ${mode === "login" ? "active" : ""}`} onClick={() => setMode("login")}>Sign in</button>
          <button className={`login-tab ${mode === "register" ? "active" : ""}`} onClick={() => setMode("register")}>Create account</button>
        </div>
        <div className="form-group">
          <label>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"
            onKeyDown={e => e.key === "Enter" && submit()} />
        </div>
        <div className="form-group">
          <label>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••"
            onKeyDown={e => e.key === "Enter" && submit()} />
        </div>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary" style={{ width: "100%", marginTop: "0.5rem" }}
          onClick={submit} disabled={loading}>
          {loading ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </div>
    </div>
  );
}

// ── New project modal ──────────────────────────────────────────────────────
function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }) {
  const [form, setForm] = useState({ name: "", repo: "", branch: "main", buildCommand: "npm run build", startCommand: "npm start", volumePath: "/workspace" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }));

  async function submit() {
    setError(""); setLoading(true);
    try {
      const data = await api<{ project: Project }>("/api/projects", {
        method: "POST", body: JSON.stringify(form),
      });
      onCreated(data.project);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>New project</h2>
        <div className="form-row">
          <div className="form-group">
            <label>Project name</label>
            <input value={form.name} onChange={set("name")} placeholder="my-app" />
          </div>
          <div className="form-group">
            <label>Branch</label>
            <input value={form.branch} onChange={set("branch")} placeholder="main" />
          </div>
        </div>
        <div className="form-group">
          <label>GitHub repo</label>
          <input value={form.repo} onChange={set("repo")} placeholder="owner/repo or https://github.com/owner/repo" />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label>Build command</label>
            <input value={form.buildCommand} onChange={set("buildCommand")} placeholder="npm run build" />
          </div>
          <div className="form-group">
            <label>Start command</label>
            <input value={form.startCommand} onChange={set("startCommand")} placeholder="npm start" />
          </div>
        </div>
        <div className="form-group">
          <label>Volume path</label>
          <input value={form.volumePath} onChange={set("volumePath")} placeholder="/workspace" />
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={loading}>
            {loading ? "Creating…" : "Create project"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Log terminal ───────────────────────────────────────────────────────────
function LogTerminal({ deploymentId, token, live }: { deploymentId: string; token: string; live: boolean }) {
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]); setDone(false);
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/api/log-stream?deploymentId=${deploymentId}&token=${token}`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "log") setLines(l => [...l, msg.line]);
      if (msg.type === "done") setDone(true);
    };
    return () => ws.close();
  }, [deploymentId]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines]);

  return (
    <div className="terminal">
      <div className="terminal-bar">
        <div className="terminal-dot red" />
        <div className="terminal-dot yellow" />
        <div className="terminal-dot green" />
        <span className="terminal-label">{live && !done ? "● live" : "● done"}</span>
      </div>
      <div className="terminal-body" ref={bodyRef}>
        {lines.length === 0 && <span className="log-line text-muted">Waiting for output…</span>}
        {lines.map((line, i) => (
          <span key={i} className={`log-line ${classifyLine(line)}`}>{line + "\n"}</span>
        ))}
        {live && !done && <span className="log-cursor" />}
      </div>
    </div>
  );
}

// ── Env editor ─────────────────────────────────────────────────────────────
function EnvEditor({ projectId, initial, onSaved }: { projectId: string; initial: Record<string, string>; onSaved: () => void }) {
  const [pairs, setPairs] = useState(() => Object.entries(initial).map(([k, v]) => ({ k, v })));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true); setSaved(false);
    const env = Object.fromEntries(pairs.filter(p => p.k).map(p => [p.k, p.v]));
    await api(`/api/projects/${projectId}/env`, { method: "PUT", body: JSON.stringify({ env }) });
    setSaving(false); setSaved(true);
    onSaved();
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div>
      {pairs.map((pair, i) => (
        <div className="env-row" key={i}>
          <input placeholder="KEY" value={pair.k} onChange={e => setPairs(p => p.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
          <input placeholder="value" value={pair.v} type="text"
            onChange={e => setPairs(p => p.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} />
          <button className="env-del-btn" onClick={() => setPairs(p => p.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="form-actions" style={{ justifyContent: "flex-start", marginTop: "0.75rem", gap: "0.6rem" }}>
        <button className="btn btn-ghost btn-sm" onClick={() => setPairs(p => [...p, { k: "", v: "" }])}>+ Add variable</button>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : saved ? "✓ Saved" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

// ── Project detail page ────────────────────────────────────────────────────
function ProjectDetail({ token }: { token: string }) {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [tab, setTab] = useState<"overview" | "logs" | "env" | "settings">("overview");
  const [activeDeployId, setActiveDeployId] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState("");
  const [settingsForm, setSettingsForm] = useState({ repo: "", branch: "", buildCommand: "", startCommand: "" });

  const load = useCallback(async () => {
    if (!id) return;
    const data = await api<{ project: Project; deployments: Deployment[] }>(`/api/projects/${id}`);
    setProject(data.project);
    setDeployments(data.deployments);
    setSettingsForm({ repo: data.project.repo, branch: data.project.branch, buildCommand: data.project.buildCommand, startCommand: data.project.startCommand });
    if (!activeDeployId && data.deployments.length) setActiveDeployId(data.deployments[0].id);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Poll while building
  useEffect(() => {
    if (project?.status !== "building") return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [project?.status, load]);

  async function deploy() {
    if (!project) return;
    setDeploying(true); setError("");
    try {
      const data = await api<{ deployment: Deployment }>(`/api/projects/${project.id}/deploy`, { method: "POST", body: JSON.stringify({ commitSha: "manual" }) });
      setActiveDeployId(data.deployment.id);
      setTab("logs");
      await load();
    } catch (e: any) { setError(e.message); } finally { setDeploying(false); }
  }

  async function stopStart() {
    if (!project) return;
    const action = project.status === "live" ? "stop" : "start";
    await api(`/api/projects/${project.id}/${action}`, { method: "POST", body: "{}" });
    await load();
  }

  async function deleteProject() {
    if (!project || !confirm(`Delete ${project.name}? This cannot be undone.`)) return;
    await api(`/api/projects/${project.id}`, { method: "DELETE" });
    nav("/");
  }

  async function saveSettings() {
    if (!project) return;
    await api(`/api/projects/${project.id}`, { method: "PUT", body: JSON.stringify(settingsForm) });
    await load();
  }

  if (!project) return <div className="loading"><div className="spinner" /> Loading…</div>;

  const activeDeployment = deployments.find(d => d.id === activeDeployId);

  return (
    <div className="page">
      <div className="detail-header">
        <div className="detail-header-info">
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <h1>{project.name}</h1>
            <Badge status={project.status} />
          </div>
          <div className="detail-repo">{project.repo} · {project.branch}</div>
          {project.domain && (
            <a href={`https://${project.domain}`} target="_blank" rel="noreferrer"
              className="project-domain" style={{ display: "block", marginTop: "4px" }}>
              https://{project.domain} ↗
            </a>
          )}
        </div>
        <div className="detail-header-actions">
          {error && <span style={{ color: "var(--danger)", fontSize: "0.82rem" }}>{error}</span>}
          <button className="btn btn-ghost btn-sm" onClick={() => nav("/")}>← Back</button>
          {project.status === "live" && (
            <button className="btn btn-ghost btn-sm" onClick={stopStart}>⏹ Stop</button>
          )}
          {project.status === "stopped" && (
            <button className="btn btn-ghost btn-sm" onClick={stopStart}>▶ Start</button>
          )}
          <button className="btn btn-primary btn-sm" onClick={deploy}
            disabled={deploying || project.status === "building"}>
            {deploying || project.status === "building" ? "Building…" : "↑ Deploy"}
          </button>
        </div>
      </div>

      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-label">Deployments</div>
          <div className="stat-value">{deployments.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Last deploy</div>
          <div className="stat-value" style={{ fontSize: "0.85rem" }}>
            {deployments[0] ? timeAgo(deployments[0].createdAt) : "Never"}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Image</div>
          <div className="stat-value text-mono" style={{ fontSize: "0.72rem", color: "var(--muted)" }}>
            {project.imageTag?.split(":").pop() ?? "—"}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Env vars</div>
          <div className="stat-value">{Object.keys(project.env).length}</div>
        </div>
      </div>

      <div className="tabs">
        {(["overview", "logs", "env", "settings"] as const).map(t => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "overview" ? "⬡ Overview" : t === "logs" ? "▶ Logs" : t === "env" ? "⚙ Environment" : "✎ Settings"}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="card">
          <div className="card-header"><h3>Deployments</h3></div>
          <div className="card-body no-pad">
            {deployments.length === 0 && (
              <div className="empty"><div className="empty-icon">🚀</div><p>No deployments yet. Hit Deploy to ship.</p></div>
            )}
            <div className="deployment-list">
              {deployments.map(dep => (
                <div key={dep.id} className="deployment-row" onClick={() => { setActiveDeployId(dep.id); setTab("logs"); }}>
                  <Badge status={dep.status} />
                  <span className="deployment-sha">{dep.commitSha.slice(0, 8)}</span>
                  <div className="deployment-meta">
                    <div className="deployment-trigger">via {dep.triggeredBy}</div>
                  </div>
                  <span className="deployment-time">{timeAgo(dep.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "logs" && (
        <div>
          {deployments.length > 1 && (
            <div style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Deployment:</span>
              <select style={{ background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border2)", borderRadius: 7, padding: "0.3rem 0.6rem", fontFamily: "var(--mono)", fontSize: "0.8rem" }}
                value={activeDeployId ?? ""} onChange={e => setActiveDeployId(e.target.value)}>
                {deployments.map(d => (
                  <option key={d.id} value={d.id}>{d.commitSha.slice(0, 8)} — {d.status} — {timeAgo(d.createdAt)}</option>
                ))}
              </select>
            </div>
          )}
          {activeDeployId ? (
            <LogTerminal deploymentId={activeDeployId} token={token}
              live={activeDeployment?.status === "building" || activeDeployment?.status === "queued"} />
          ) : (
            <div className="empty"><div className="empty-icon">▶</div><p>No deployment selected.</p></div>
          )}
        </div>
      )}

      {tab === "env" && (
        <div className="card">
          <div className="card-header"><h3>Environment variables</h3></div>
          <div className="card-body">
            <p style={{ fontSize: "0.82rem", color: "var(--muted)", marginBottom: "1.25rem" }}>
              These are injected into your container at runtime. Redeploy after changes.
            </p>
            <EnvEditor projectId={project.id} initial={project.env} onSaved={load} />
          </div>
        </div>
      )}

      {tab === "settings" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div className="card">
            <div className="card-header"><h3>Project settings</h3></div>
            <div className="card-body">
              <div className="form-group">
                <label>Repository</label>
                <input value={settingsForm.repo} onChange={e => setSettingsForm(f => ({ ...f, repo: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Branch</label>
                <input value={settingsForm.branch} onChange={e => setSettingsForm(f => ({ ...f, branch: e.target.value }))} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Build command</label>
                  <input value={settingsForm.buildCommand} onChange={e => setSettingsForm(f => ({ ...f, buildCommand: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Start command</label>
                  <input value={settingsForm.startCommand} onChange={e => setSettingsForm(f => ({ ...f, startCommand: e.target.value }))} />
                </div>
              </div>
              <div className="form-actions">
                <button className="btn btn-primary btn-sm" onClick={saveSettings}>Save</button>
              </div>
            </div>
          </div>
          <div className="card" style={{ borderColor: "rgba(244,63,94,0.2)" }}>
            <div className="card-header"><h3 style={{ color: "var(--danger)" }}>Danger zone</h3></div>
            <div className="card-body" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.88rem" }}>Delete this project</div>
                <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: "2px" }}>Stops the container and removes all deployment history.</div>
              </div>
              <button className="btn btn-danger btn-sm" onClick={deleteProject}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Projects list page ─────────────────────────────────────────────────────
function ProjectsList({ token }: { token: string }) {
  const nav = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const data = await api<{ projects: Project[] }>("/api/projects");
    setProjects(data.projects);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll if any project is building
  useEffect(() => {
    const building = projects.some(p => p.status === "building");
    if (!building) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [projects, load]);

  return (
    <div className="page">
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <h1>Projects</h1>
          <p>{projects.length} project{projects.length !== 1 ? "s" : ""} · push to deploy</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New project</button>
      </div>

      {loading && <div className="empty"><div className="spinner" /></div>}

      {!loading && projects.length === 0 && (
        <div className="empty">
          <div className="empty-icon">⬡</div>
          <p>No projects yet. Create one and ship something.</p>
          <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>+ New project</button>
        </div>
      )}

      <div className="projects-grid">
        {projects.map(p => (
          <div key={p.id} className="project-card" onClick={() => nav(`/projects/${p.id}`)}>
            <div className="project-card-top">
              <div>
                <div className="project-name">{p.name}</div>
                <div className="project-repo">{p.repo} · {p.branch}</div>
              </div>
              <Badge status={p.status} />
            </div>
            {p.domain && <div className="project-domain">https://{p.domain}</div>}
            <div className="project-card-meta">
              <span>{p.latestDeployment ? `Last deploy ${timeAgo(p.latestDeployment.createdAt)}` : "No deploys yet"}</span>
              <span>{Object.keys(p.env).length} env vars</span>
            </div>
          </div>
        ))}
      </div>

      {showNew && (
        <NewProjectModal
          onClose={() => setShowNew(false)}
          onCreated={(proj) => { setShowNew(false); nav(`/projects/${proj.id}`); }}
        />
      )}
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────
function Sidebar({ user, onLogout }: { user: User; onLogout: () => void }) {
  const nav = useNavigate();
  const path = window.location.pathname;

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="wordmark">⬡ nexus-deploy</div>
        <div className="sub">The No Hands Company</div>
      </div>
      <nav className="sidebar-nav">
        <button className={`nav-link ${path === "/" ? "active" : ""}`} onClick={() => nav("/")}>
          <span className="icon">⬡</span> Projects
        </button>
        <button className={`nav-link`} onClick={() => window.open("https://github.com/The-No-Hands-company/nexus-deploy", "_blank")}>
          <span className="icon">↗</span> GitHub
        </button>
      </nav>
      <div className="sidebar-user">
        <div className="role-badge">{user.role}</div>
        <div className="email">{user.email}</div>
        <button className="logout-btn" onClick={onLogout}>Sign out</button>
      </div>
    </aside>
  );
}

// ── App shell ──────────────────────────────────────────────────────────────
function AppShell({ token, user, onLogout }: { token: string; user: User; onLogout: () => void }) {
  return (
    <div className="shell">
      <Sidebar user={user} onLogout={onLogout} />
      <main className="main">
        <Routes>
          <Route path="/" element={<ProjectsList token={token} />} />
          <Route path="/projects/:id" element={<ProjectDetail token={token} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

// ── Root ───────────────────────────────────────────────────────────────────
export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("nexus-token"));
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!token) { setChecking(false); return; }
    fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { setUser(data.user); setChecking(false); })
      .catch(() => { setToken(null); setChecking(false); });
  }, [token]);

  function logout() {
    localStorage.removeItem("nexus-token");
    setToken(null); setUser(null);
  }

  if (checking) return <div className="loading"><div className="spinner" /> Nexus Deploy</div>;
  if (!token || !user) {
    return (
      <BrowserRouter>
        <Login onAuthed={(t, u) => { setToken(t); setUser(u); }} />
      </BrowserRouter>
    );
  }

  return (
    <BrowserRouter>
      <AppShell token={token} user={user} onLogout={logout} />
    </BrowserRouter>
  );
}
ENDTSX