import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { appUrlFor, useApi } from "../api";
import type { ActivityItem, LimitsResponse, NodeInfo, Project } from "../types";
import { NewProjectModal } from "./NewProjectModal";
import { Badge } from "./StatusStates";

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ProjectsList({
  node,
  onCountsChange,
}: {
  node: NodeInfo;
  onCountsChange: (c: { total: number; live: number; building: number }) => void;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [limitsInfo, setLimitsInfo] = useState<LimitsResponse | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const updateCounts = useCallback(
    (list: Project[]) => {
      onCountsChange({
        total: list.length,
        live: list.filter((p) => p.status === "live").length,
        building: list.filter((p) => p.status === "building").length,
      });
    },
    [onCountsChange],
  );

  const load = useCallback(async () => {
    const [pData, aData, lData] = await Promise.all([
      api.get("/api/projects"),
      api.get("/api/activity").catch(() => ({ activity: [] })),
      api.get("/api/limits").catch(() => null),
    ]);
    setProjects(pData.projects ?? []);
    updateCounts(pData.projects ?? []);
    setActivity(aData.activity ?? []);
    if (lData) setLimitsInfo(lData);
    setLoading(false);
  }, [api, updateCounts]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "status") {
          setProjects((prev) => {
            const updated = prev.map((p) =>
              p.id === msg.projectId ? { ...p, status: msg.status } : p,
            );
            updateCounts(updated);
            return updated;
          });
        }
      } catch {
        /* ignore malformed event */
      }
    };
    return () => es.close();
  }, [updateCounts]);

  const filtered = projects.filter((p) => {
    const matchSearch =
      !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.repo.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === "all" || p.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const exampleUrl = appUrlFor({ name: "your-app" }, node);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="subtitle">
            Deploy a Git repository or container image to an isolated HTTPS subdomain.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setShowNew(true)}>
          + New Project
        </button>
      </div>

      {loading && (
        <div className="loading">
          <div className="spinner" /> Loading projects…
        </div>
      )}

      {!loading && projects.length === 0 && (
        <div className="onboarding">
          <div className="onboarding-header">
            <div style={{ fontSize: 36, color: "var(--accent)", marginBottom: 8 }}>⬡</div>
            <h2>Deploy your first app</h2>
            <p className="subtitle" style={{ marginTop: 4 }}>
              Free forever · Rootless container sandbox · Zero visitor tracking
            </p>
          </div>
          <div className="onboarding-steps">
            <div className="onboarding-step">
              <div className="step-num">1</div>
              <div>
                <strong>Choose a source</strong>
                <p className="muted" style={{ marginTop: 4 }}>
                  Connect a public or private Git repository, or pull any OCI container image.
                </p>
              </div>
            </div>
            <div className="onboarding-step">
              <div className="step-num">2</div>
              <div>
                <strong>Build in the sandbox</strong>
                <p className="muted" style={{ marginTop: 4 }}>
                  Railpack detects Node, Python, Go, Rust, or uses your Dockerfile inside a rootless
                  BuildKit daemon.
                </p>
              </div>
            </div>
            <div className="onboarding-step">
              <div className="step-num">3</div>
              <div>
                <strong>Blue/green live release</strong>
                <p className="muted" style={{ marginTop: 4 }}>
                  Once the health probe passes, your app goes live at <code>{exampleUrl}</code>.
                </p>
              </div>
            </div>
          </div>
          <div style={{ textAlign: "center", marginTop: 24 }}>
            <button type="button" className="btn-primary" onClick={() => setShowNew(true)}>
              + Create Your First Project →
            </button>
          </div>
        </div>
      )}

      {!loading && projects.length > 0 && (
        <>
          <div className="filter-bar">
            <input
              className="search-input"
              placeholder="Search projects…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="filter-pills">
              {(["all", "live", "building", "failed", "stopped", "idle"] as const).map((s) => (
                <button
                  type="button"
                  key={s}
                  className={`filter-pill ${statusFilter === s ? "active" : ""}`}
                  onClick={() => setStatusFilter(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="projects-layout">
            <div>
              {filtered.length === 0 ? (
                <p className="muted">No projects match your filter.</p>
              ) : (
                <div className="projects-grid">
                  {filtered.map((p) => (
                    <article key={p.id} className="project-card">
                      <div className="pc-top">
                        <button
                          type="button"
                          className="pc-name-btn"
                          onClick={() => navigate(`/projects/${p.id}`)}
                        >
                          {p.name}
                        </button>
                        <Badge status={p.status} />
                      </div>
                      <div className="pc-repo">
                        {p.source?.type === "image" ? `📦 ${p.source.image}` : p.repo}
                      </div>
                      <div className="pc-meta">
                        {p.source?.type === "image" ? (
                          <span>image</span>
                        ) : (
                          <span>⎇ {p.branch}</span>
                        )}
                        <span>·</span>
                        <span>:{p.port}</span>
                        {p.latestDeployment && (
                          <>
                            <span>·</span>
                            <span>{timeAgo(p.latestDeployment.createdAt)}</span>
                          </>
                        )}
                      </div>
                      {p.status === "live" && (
                        <a
                          className="pc-url"
                          href={appUrlFor(p, node)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          ↗ {appUrlFor(p, node).replace(/^https?:\/\//, "")}
                        </a>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>

            {activity.length > 0 && (
              <div className="activity-panel">
                <div className="activity-title">Recent Activity</div>
                <div className="activity-list">
                  {activity.slice(0, 12).map((a) => (
                    <button
                      type="button"
                      key={a.id}
                      className="activity-item"
                      onClick={() => navigate(`/projects/${a.projectId}`)}
                    >
                      <span
                        className="activity-dot"
                        style={{
                          background:
                            a.status === "live"
                              ? "var(--success)"
                              : a.status === "failed"
                                ? "var(--danger)"
                                : "var(--warn)",
                        }}
                      />
                      <div className="activity-body">
                        <div className="activity-project">{a.projectName}</div>
                        <div className="activity-meta">
                          {a.commitSha.slice(0, 8)} · {a.triggeredBy} · {timeAgo(a.createdAt)}
                        </div>
                      </div>
                      <Badge status={a.status} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {limitsInfo && (
        <div className="safeguards-bar">
          <span>
            <strong>Shared-node safeguards</strong> (equal for every member, not billing tiers):{" "}
            {limitsInfo.limits.maxProjectsPerMember} projects · {limitsInfo.limits.memory} RAM ·{" "}
            {limitsInfo.limits.cpus} CPU · {limitsInfo.limits.pidsLimit} PIDs ·{" "}
            {limitsInfo.limits.buildsPerHour} builds/hr
          </span>
          <span>Availability: {limitsInfo.availability}</span>
        </div>
      )}

      {showNew && (
        <NewProjectModal
          node={node}
          onClose={() => setShowNew(false)}
          onCreated={(p) => {
            setShowNew(false);
            navigate(`/projects/${p.id}`);
          }}
        />
      )}
    </div>
  );
}
