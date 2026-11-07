import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { appUrlFor, shortLinkUrlFor, useApi } from "../api";
import type { Deployment, NodeInfo, Project } from "../types";
import { ProjectSettingsTab } from "./ProjectSettingsTab";
import { Badge, LogTerminal, StatPill } from "./StatusStates";

export function ProjectDetail({ wsToken, node }: { wsToken: string; node: NodeInfo }) {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const navigate = useNavigate();

  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [activeDep, setActiveDep] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "logs" | "live" | "env" | "webhook" | "settings">(
    "overview",
  );
  const [deploying, setDeploying] = useState(false);
  const [deployErr, setDeployErr] = useState("");
  const [stats, setStats] = useState<{ cpu: string; mem: string; memPercent: string } | null>(null);
  const [envPairs, setEnvPairs] = useState<Array<{ id: number; key: string; val: string }>>([]);
  const [nextEnvId, setNextEnvId] = useState(1);
  const [envSaved, setEnvSaved] = useState(false);
  const [webhookCopied, setWebhookCopied] = useState<"url" | "secret" | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const d = await api.get(`/api/projects/${id}`);
    setProject(d.project);
    setDeployments(d.deployments ?? []);
    if (d.deployments?.[0]) {
      setActiveDep((prev) => prev ?? d.deployments[0].id);
    }
    const entries = Object.entries(d.project.env ?? {});
    setEnvPairs(entries.map(([key, val], i) => ({ id: i + 1, key, val: val as string })));
    setNextEnvId(entries.length + 1);
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!project || (project.status !== "building" && !deploying)) return;
    const t = setInterval(async () => {
      const d = await api.get(`/api/projects/${id}`);
      setProject(d.project);
      setDeployments(d.deployments ?? []);
      if (d.project.status !== "building") setDeploying(false);
    }, 2500);
    return () => clearInterval(t);
  }, [project?.status, deploying, id, api, project]);

  useEffect(() => {
    if (!project || project.status !== "live") {
      setStats(null);
      return;
    }
    const fetchStats = () =>
      api
        .get(`/api/projects/${id}/stats`)
        .then((d) => setStats(d.stats ?? null))
        .catch(() => {});
    fetchStats();
    const t = setInterval(fetchStats, 8000);
    return () => clearInterval(t);
  }, [project?.status, id, api, project]);

  async function triggerDeploy() {
    setDeploying(true);
    setDeployErr("");
    try {
      const { deployment } = await api.post(`/api/projects/${id}/deploy`, {});
      setActiveDep(deployment.id);
      setTab("logs");
      await load();
    } catch (e: unknown) {
      setDeployErr(e instanceof Error ? e.message : "Deploy failed");
      setDeploying(false);
    }
  }

  async function triggerRollback(depId: string) {
    if (!confirm("Roll back to this deployment image?")) return;
    setDeploying(true);
    try {
      const { deployment } = await api.post(`/api/deployments/${depId}/rollback`, {});
      setActiveDep(deployment.id);
      setTab("logs");
      await load();
    } catch (e: unknown) {
      setDeployErr(e instanceof Error ? e.message : "Rollback failed");
      setDeploying(false);
    }
  }

  async function cancelActiveBuild() {
    const running = deployments.find((d) => d.status === "building" || d.status === "queued");
    if (!running) return;
    try {
      await api.post(`/api/deployments/${running.id}/cancel`);
      setDeploying(false);
      await load();
    } catch (e: unknown) {
      setDeployErr(e instanceof Error ? e.message : "Cancel failed");
    }
  }

  async function deleteDeploymentLog(depId: string) {
    try {
      await api.del(`/api/deployments/${depId}/logs`);
      await load();
    } catch (e: unknown) {
      setDeployErr(e instanceof Error ? e.message : "Could not delete build log");
    }
  }

  async function saveEnv() {
    const env: Record<string, string> = {};
    for (const p of envPairs) {
      if (p.key.trim()) env[p.key.trim()] = p.val;
    }
    await api.put(`/api/projects/${id}/env`, { env });
    setEnvSaved(true);
    setTimeout(() => setEnvSaved(false), 2500);
  }

  function copyText(text: string, which: "url" | "secret") {
    navigator.clipboard.writeText(text);
    setWebhookCopied(which);
    setTimeout(() => setWebhookCopied(null), 2000);
  }

  if (!project) {
    return (
      <div className="loading">
        <div className="spinner" /> Loading…
      </div>
    );
  }

  const webhookUrl = `${window.location.origin}/api/webhooks/github/${project.id}`;
  const isBuilding = project.status === "building" || deploying;
  const appUrl = appUrlFor(project, node);
  const shortUrl = shortLinkUrlFor(project, node);
  const releaseMode = project.volumePath ? "Stop-then-start (volume)" : "Blue/green zero-downtime";

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <button type="button" className="back-btn" onClick={() => navigate("/")}>
            ← Projects
          </button>
          <h1>
            {project.name} <Badge status={project.status} />
          </h1>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 4 }}>
            {project.status === "live" && (
              <>
                <a className="pc-url" href={appUrl} target="_blank" rel="noreferrer">
                  ↗ {appUrl}
                </a>
                <a className="muted" href={shortUrl} target="_blank" rel="noreferrer">
                  short link: {shortUrl}
                </a>
              </>
            )}
          </div>
        </div>
        <div className="header-actions">
          <StatPill label="Release" value={releaseMode} />
          {stats && (
            <>
              <StatPill label="CPU" value={stats.cpu} />
              <StatPill label="RAM" value={`${stats.mem} (${stats.memPercent})`} />
            </>
          )}
          {project.status === "live" && (
            <>
              <button
                type="button"
                className="btn-ghost"
                onClick={async () => {
                  await api.post(`/api/projects/${id}/restart`);
                  await load();
                }}
              >
                ↺ Restart
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={async () => {
                  await api.post(`/api/projects/${id}/stop`);
                  await load();
                }}
              >
                ⏸ Stop
              </button>
            </>
          )}
          {project.status === "stopped" && (
            <button
              type="button"
              className="btn-ghost"
              onClick={async () => {
                await api.post(`/api/projects/${id}/start`);
                await load();
              }}
            >
              ▶ Start
            </button>
          )}
          {isBuilding && (
            <button type="button" className="btn-danger" onClick={cancelActiveBuild}>
              ✕ Cancel Build
            </button>
          )}
          <button
            type="button"
            className="btn-primary"
            onClick={triggerDeploy}
            disabled={isBuilding}
          >
            {isBuilding ? (
              <>
                <span className="spinner-sm" /> Building…
              </>
            ) : (
              "⚡ Deploy Now"
            )}
          </button>
        </div>
      </div>

      {deployErr && (
        <div className="form-error" style={{ marginBottom: 16 }}>
          {deployErr}
        </div>
      )}

      <div className="tabs">
        {(["overview", "logs", "live", "env", "webhook", "settings"] as const).map((t) => (
          <button
            type="button"
            key={t}
            className={`tab ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "overview" && "📋 Overview"}
            {t === "logs" && "🔨 Build Logs"}
            {t === "live" && "📡 Live Logs"}
            {t === "env" && "⚙ Environment"}
            {t === "webhook" && "⚡ Webhook"}
            {t === "settings" && "🔧 Settings"}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="tab-content">
          <div className="overview-grid">
            <div className="info-card">
              <h3>Project Info</h3>
              <div className="info-rows">
                <div className="info-row">
                  <span>Source</span>
                  <span className="mono">
                    {project.source?.type === "image"
                      ? `image: ${project.source.image}`
                      : `git: ${project.repo}`}
                  </span>
                </div>
                {project.source?.type !== "image" && (
                  <div className="info-row">
                    <span>Branch</span>
                    <span className="mono">{project.branch}</span>
                  </div>
                )}
                {project.source?.type === "git" && (
                  <div className="info-row">
                    <span>Private Token</span>
                    <span className="mono">
                      {project.source.hasToken ? "🔒 configured" : "none"}
                    </span>
                  </div>
                )}
                <div className="info-row">
                  <span>Port</span>
                  <span className="mono">:{project.port}</span>
                </div>
                <div className="info-row">
                  <span>Health Path</span>
                  <span className="mono">{project.healthPath || "/"}</span>
                </div>
                <div className="info-row">
                  <span>Release Mode</span>
                  <span className="mono">{releaseMode}</span>
                </div>
                {project.volumePath && (
                  <div className="info-row">
                    <span>Volume</span>
                    <span className="mono">{project.volumePath}</span>
                  </div>
                )}
                <div className="info-row">
                  <span>Auto-deploy</span>
                  <span className="mono">
                    {project.autoDeployEnabled ? "✓ enabled" : "✗ disabled"}
                  </span>
                </div>
              </div>
            </div>

            <div className="info-card">
              <h3>Deployments ({deployments.length})</h3>
              {deployments.length === 0 && <p className="muted">No deployments yet.</p>}
              <div className="deploy-list">
                {deployments.slice(0, 12).map((d) => (
                  <div key={d.id} className="deploy-row">
                    <button
                      type="button"
                      className="deploy-row-left"
                      onClick={() => {
                        setActiveDep(d.id);
                        setTab("logs");
                      }}
                    >
                      <Badge status={d.status} />
                      <span className="mono">{d.commitSha.slice(0, 12)}</span>
                      <span className="trigger-tag">{d.triggeredBy}</span>
                    </button>
                    <div className="deploy-row-actions">
                      <span className="muted">{new Date(d.createdAt).toLocaleString()}</span>
                      {d.imageTag && (
                        <button
                          type="button"
                          className="icon-btn"
                          title="Roll back to this image"
                          onClick={() => triggerRollback(d.id)}
                          disabled={isBuilding}
                        >
                          ↩
                        </button>
                      )}
                      {d.status !== "building" && d.status !== "queued" && (
                        <button
                          type="button"
                          className="icon-btn danger"
                          title="Delete build log"
                          onClick={() => deleteDeploymentLog(d.id)}
                        >
                          🗑
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "logs" && (
        <div className="tab-content">
          {deployments.length > 0 && (
            <div className="filter-bar">
              <div className="filter-pills">
                {deployments.slice(0, 8).map((d) => (
                  <button
                    type="button"
                    key={d.id}
                    className={`filter-pill ${activeDep === d.id ? "active" : ""}`}
                    onClick={() => setActiveDep(d.id)}
                  >
                    <Badge status={d.status} /> {d.commitSha.slice(0, 8)}
                  </button>
                ))}
              </div>
              {activeDep && (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => deleteDeploymentLog(activeDep)}
                >
                  🗑 Delete This Build Log
                </button>
              )}
            </div>
          )}
          {activeDep ? (
            <LogTerminal deploymentId={activeDep} wsToken={wsToken} mode="build" />
          ) : (
            <p className="muted">No deployment selected.</p>
          )}
        </div>
      )}

      {tab === "live" && (
        <div className="tab-content">
          <LogTerminal projectId={project.id} wsToken={wsToken} mode="container" />
        </div>
      )}

      {tab === "env" && (
        <div className="tab-content">
          <div className="info-card">
            <h3>Environment Variables</h3>
            <p className="field-hint" style={{ marginBottom: 16 }}>
              Encrypted at rest with AES-256-GCM. Save and redeploy to inject updated variables.
            </p>
            {envPairs.map((pair, idx) => (
              <div key={pair.id} className="env-row">
                <input
                  placeholder="KEY"
                  value={pair.key}
                  onChange={(e) => {
                    const next = [...envPairs];
                    next[idx] = { ...pair, key: e.target.value };
                    setEnvPairs(next);
                  }}
                />
                <input
                  placeholder="value"
                  value={pair.val}
                  onChange={(e) => {
                    const next = [...envPairs];
                    next[idx] = { ...pair, val: e.target.value };
                    setEnvPairs(next);
                  }}
                />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setEnvPairs(envPairs.filter((_, j) => j !== idx))}
                >
                  ✕
                </button>
              </div>
            ))}
            <div style={{ display: "flex", gap: 10, marginTop: 12, alignItems: "center" }}>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setEnvPairs([...envPairs, { id: nextEnvId, key: "", val: "" }]);
                  setNextEnvId((n) => n + 1);
                }}
              >
                + Add Variable
              </button>
              <button type="button" className="btn-primary" onClick={saveEnv}>
                Save Variables
              </button>
              {envSaved && <span style={{ color: "var(--success)", fontSize: 13 }}>✓ Saved</span>}
            </div>
          </div>
        </div>
      )}

      {tab === "webhook" && (
        <div className="tab-content">
          <div className="info-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>Push-to-Deploy Webhook</h3>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={project.autoDeployEnabled}
                  onChange={async () => {
                    await api.put(`/api/projects/${id}`, {
                      autoDeployEnabled: !project.autoDeployEnabled,
                    });
                    await load();
                  }}
                />
                <span className="mono">
                  {project.autoDeployEnabled ? "Auto-deploy enabled" : "Auto-deploy paused"}
                </span>
              </label>
            </div>
            <div style={{ marginTop: 14 }}>
              <div className="field-hint">Payload URL</div>
              <div className="copy-row">
                <code className="code-block">{webhookUrl}</code>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => copyText(webhookUrl, "url")}
                >
                  {webhookCopied === "url" ? "✓ Copied" : "Copy"}
                </button>
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <div className="field-hint">Webhook Secret (HMAC-SHA256)</div>
              <div className="copy-row">
                <code className="code-block">{project.webhookSecret}</code>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => copyText(project.webhookSecret, "secret")}
                >
                  {webhookCopied === "secret" ? "✓ Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={async () => {
                    if (!confirm("Regenerate webhook secret?")) return;
                    const { webhookSecret } = await api.post(
                      `/api/projects/${id}/regen-webhook-secret`,
                    );
                    setProject((p) => (p ? { ...p, webhookSecret } : p));
                  }}
                >
                  ↺ Regenerate
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "settings" && (
        <ProjectSettingsTab project={project} onReload={load} onDeleted={() => navigate("/")} />
      )}
    </div>
  );
}
