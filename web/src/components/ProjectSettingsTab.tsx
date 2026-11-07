import { type FormEvent, useState } from "react";
import { useApi } from "../api";
import type { Project } from "../types";

export function ProjectSettingsTab({
  project,
  onReload,
  onDeleted,
}: {
  project: Project;
  onReload: () => Promise<void>;
  onDeleted: () => void;
}) {
  const api = useApi();
  const initialType = project.source?.type ?? "git";
  const [sourceType, setSourceType] = useState<"git" | "image">(initialType);
  const [repo, setRepo] = useState(
    project.source?.type === "git" ? project.source.repo : project.repo,
  );
  const [branch, setBranch] = useState(
    project.source?.type === "git" ? project.source.branch : project.branch || "main",
  );
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [image, setImage] = useState(project.source?.type === "image" ? project.source.image : "");
  const [buildContext, setBuildContext] = useState(project.buildContext ?? "");
  const [dockerfile, setDockerfile] = useState(project.dockerfile ?? "");
  const [healthPath, setHealthPath] = useState(project.healthPath ?? "");
  const [buildCommand, setBuildCommand] = useState(project.buildCommand);
  const [startCommand, setStartCommand] = useState(project.startCommand);
  const [volumePath, setVolumePath] = useState(project.volumePath);
  const [port, setPort] = useState(project.port);
  const [memoryLimit, setMemoryLimit] = useState(project.memoryLimit ?? "");
  const [cpus, setCpus] = useState(project.cpus ?? "");
  const [notifyUrl, setNotifyUrl] = useState(project.notifyUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const hasSavedToken = project.source?.type === "git" && project.source.hasToken;

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg("");
    setErr("");
    try {
      const source =
        sourceType === "git"
          ? {
              type: "git" as const,
              repo,
              branch,
              ...(clearToken ? { token: "" } : token.trim() ? { token: token.trim() } : {}),
            }
          : { type: "image" as const, image: image.trim() };

      await api.put(`/api/projects/${project.id}`, {
        source,
        buildContext,
        dockerfile,
        healthPath,
        buildCommand,
        startCommand,
        volumePath,
        port,
        memoryLimit,
        cpus,
        notifyUrl,
      });
      setToken("");
      setClearToken(false);
      await onReload();
      setMsg("Saved. Redeploy to apply container changes.");
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function exportProject() {
    try {
      const data = await api.get(`/api/projects/${project.id}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.name}.nexus-deploy.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : "Failed to export project");
    }
  }

  async function deleteProject() {
    if (
      !confirm(
        `Delete "${project.name}"? This removes its container, volume, images, build logs, route, and slug.`,
      )
    ) {
      return;
    }
    await api.del(`/api/projects/${project.id}`);
    onDeleted();
  }

  return (
    <div className="tab-content">
      <div className="info-card">
        <h3>Project Settings</h3>
        <form onSubmit={save} className="settings-form">
          <div className="field">
            <span>Deploy Source</span>
            <div className="filter-pills">
              <button
                type="button"
                className={`filter-pill ${sourceType === "git" ? "active" : ""}`}
                onClick={() => setSourceType("git")}
              >
                Git Repository
              </button>
              <button
                type="button"
                className={`filter-pill ${sourceType === "image" ? "active" : ""}`}
                onClick={() => setSourceType("image")}
              >
                Docker Image
              </button>
            </div>
          </div>

          {sourceType === "git" ? (
            <>
              <div className="field-row">
                <label className="field">
                  <span>Git Repository</span>
                  <input value={repo} onChange={(e) => setRepo(e.target.value)} required />
                </label>
                <label className="field" style={{ maxWidth: 160 }}>
                  <span>Branch</span>
                  <input value={branch} onChange={(e) => setBranch(e.target.value)} />
                </label>
              </div>
              <label className="field">
                <span>
                  Private Repository Token{" "}
                  <em>({hasSavedToken ? "stored — leave blank to keep" : "none stored"})</em>
                </span>
                <input
                  type="password"
                  placeholder={hasSavedToken ? "Enter a new token to replace" : "ghp_… or glpat-…"}
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    if (e.target.value) setClearToken(false);
                  }}
                  autoComplete="new-password"
                />
                {hasSavedToken && (
                  <label
                    style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: 4 }}
                  >
                    <input
                      type="checkbox"
                      checked={clearToken}
                      onChange={(e) => setClearToken(e.target.checked)}
                    />
                    <span className="field-hint">Remove stored repository token on save</span>
                  </label>
                )}
              </label>
              <div className="field-row">
                <label className="field">
                  <span>Build Context</span>
                  <input
                    placeholder=". or apps/server"
                    value={buildContext}
                    onChange={(e) => setBuildContext(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Dockerfile</span>
                  <input
                    placeholder="Dockerfile (blank uses Railpack)"
                    value={dockerfile}
                    onChange={(e) => setDockerfile(e.target.value)}
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>Build Command</span>
                  <input value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} />
                </label>
                <label className="field">
                  <span>Start Command</span>
                  <input value={startCommand} onChange={(e) => setStartCommand(e.target.value)} />
                </label>
              </div>
            </>
          ) : (
            <label className="field">
              <span>OCI Image Reference</span>
              <input
                placeholder="nginxinc/nginx-unprivileged:alpine"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                required
              />
            </label>
          )}

          <div className="field-row">
            <label className="field" style={{ maxWidth: 140 }}>
              <span>Port</span>
              <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
            </label>
            <label className="field">
              <span>Health Probe Path</span>
              <input
                placeholder="/ or /health"
                value={healthPath}
                onChange={(e) => setHealthPath(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Persistent Volume Path</span>
              <input
                placeholder="/data (blank for stateless)"
                value={volumePath}
                onChange={(e) => setVolumePath(e.target.value)}
              />
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>Memory Limit</span>
              <input
                placeholder="512m (capped by node safeguard)"
                value={memoryLimit}
                onChange={(e) => setMemoryLimit(e.target.value)}
              />
            </label>
            <label className="field">
              <span>CPU Limit</span>
              <input
                placeholder="0.5 (capped by node safeguard)"
                value={cpus}
                onChange={(e) => setCpus(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Deploy Notification Webhook</span>
              <input
                placeholder="https://hooks.slack.com/…"
                value={notifyUrl}
                onChange={(e) => setNotifyUrl(e.target.value)}
              />
            </label>
          </div>

          {err && <div className="form-error">{err}</div>}
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? <span className="spinner-sm" /> : "Save Settings"}
            </button>
            <button type="button" className="btn-ghost" onClick={exportProject}>
              ⬇ Export Project JSON
            </button>
            {msg && <span style={{ color: "var(--success)", fontSize: 13 }}>{msg}</span>}
          </div>
        </form>
      </div>

      <div className="info-card danger-zone">
        <h3>Danger Zone</h3>
        <p style={{ color: "var(--text2)", fontSize: 13, marginBottom: 14 }}>
          Deleting a project stops and removes its container, persistent volume, images, build logs,
          published route, and reserved slug.
        </p>
        <button type="button" className="btn-danger" onClick={deleteProject}>
          Delete Project
        </button>
      </div>
    </div>
  );
}
