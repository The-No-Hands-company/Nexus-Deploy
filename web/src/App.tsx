import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";

type User = { id: string; email: string; role: string };
type Project = { id: string; name: string; repo: string; branch: string; volumePath: string; buildCommand: string; startCommand: string; updatedAt: number };
type Deployment = { id: string; projectId: string; commitSha: string; status: string; createdAt: number; logs: string[] };

const API = "";

function useSession() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("nexus-token"));
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    if (!token) return;
    fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => setUser(data.user))
      .catch(() => setToken(null));
  }, [token]);
  return { token, setToken, user, setUser };
}

function Login({ onAuthed }: { onAuthed: (token: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const nav = useNavigate();
  async function submit(kind: "login" | "register") {
    const res = await fetch(`${API}/api/auth/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return setMessage(data.error ?? "Failed");
    localStorage.setItem("nexus-token", data.token);
    onAuthed(data.token);
    nav("/");
  }
  return (
    <div className="auth-shell">
      <div className="card">
        <p className="eyebrow">Nexus Deploy</p>
        <h1>Railway-inspired hosting for The No Hands Company</h1>
        <p className="muted">Push a repo, add env vars, mount a volume, ship it.</p>
        <input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
        <input placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} />
        <div className="row">
          <button onClick={() => submit("login")}>Sign in</button>
          <button className="ghost" onClick={() => submit("register")}>Create account</button>
        </div>
        {message && <p className="error">{message}</p>}
      </div>
    </div>
  );
}

function Dashboard({ token, user }: { token: string; user: User }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [name, setName] = useState("Nexus.computer");
  const [repo, setRepo] = useState("The-No-Hands-company/nexus-computer");
  const [branch, setBranch] = useState("main");

  async function refresh() {
    const [p, d] = await Promise.all([
      fetch(`${API}/api/projects`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch(`${API}/api/deployments`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
    ]);
    setProjects(p.projects ?? []);
    setDeployments(d.deployments ?? []);
  }

  useEffect(() => { refresh(); }, []);

  async function createProject() {
    await fetch(`${API}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, repo, branch, buildCommand: "npm run build", startCommand: "npm start", volumePath: "/workspace" }),
    });
    refresh();
  }

  async function deploy(id: string) {
    await fetch(`${API}/api/projects/${id}/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ commitSha: "manual" }),
    });
    refresh();
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h2>Nexus Deploy</h2>
        <p>{user.email}</p>
        <nav>
          <Link to="/">Projects</Link>
          <Link to="/deployments">Deployments</Link>
          <a href="https://railway.app" target="_blank" rel="noreferrer">Railway reference</a>
        </nav>
      </aside>
      <main className="content">
        <section className="hero">
          <p className="eyebrow">Live hosting control</p>
          <h1>Ship with one repo, one volume, one click.</h1>
          <p className="muted">Auto-detect Dockerfiles, attach persistent storage, and watch deploy logs in real time.</p>
        </section>
        <section className="grid">
          <div className="card">
            <h3>Create project</h3>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Project name" />
            <input value={repo} onChange={e => setRepo(e.target.value)} placeholder="GitHub repo" />
            <input value={branch} onChange={e => setBranch(e.target.value)} placeholder="Branch" />
            <button onClick={createProject}>Create</button>
          </div>
          <div className="card">
            <h3>Projects</h3>
            {projects.map(project => (
              <div key={project.id} className="item">
                <div>
                  <strong>{project.name}</strong>
                  <p>{project.repo} · {project.branch} · {project.volumePath}</p>
                </div>
                <button onClick={() => deploy(project.id)}>Deploy</button>
              </div>
            ))}
          </div>
        </section>
        <section className="card">
          <h3>Recent deployments</h3>
          {deployments.map(dep => (
            <div key={dep.id} className="item">
              <div>
                <strong>{dep.commitSha}</strong>
                <p>{dep.status}</p>
              </div>
              <span>{new Date(dep.createdAt).toLocaleString()}</span>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}

export default function App() {
  const session = useSession();
  if (!session.token) return <Routes><Route path="*" element={<Login onAuthed={token => session.setToken(token)} />} /></Routes>;
  if (!session.user) return <div className="loading">Loading…</div>;
  return (
    <Routes>
      <Route path="/" element={<Dashboard token={session.token} user={session.user} />} />
      <Route path="/deployments" element={<Dashboard token={session.token} user={session.user} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
