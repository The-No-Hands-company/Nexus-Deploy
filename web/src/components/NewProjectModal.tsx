import { type FormEvent, useState } from "react";
import { appUrlFor, useApi } from "../api";
import type { NodeInfo, Project } from "../types";

export function NewProjectModal({
  node,
  onClose,
  onCreated,
}: {
  node: NodeInfo;
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const api = useApi();
  const [sourceType, setSourceType] = useState<"git" | "image">("git");
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [token, setToken] = useState("");
  const [buildContext, setBuildContext] = useState("");
  const [dockerfile, setDockerfile] = useState("");
  const [image, setImage] = useState("");
  const [port, setPort] = useState(3000);
  const [healthPath, setHealthPath] = useState("");
  const [volumePath, setVolumePath] = useState("");
  const [buildCommand, setBuildCommand] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [envPairs, setEnvPairs] = useState([{ id: 1, key: "", val: "" }]);
  const [nextEnvId, setNextEnvId] = useState(2);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const slugPreview = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const env: Record<string, string> = {};
      for (const p of envPairs) {
        if (p.key.trim()) env[p.key.trim()] = p.val;
      }
      const source =
        sourceType === "git"
          ? {
              type: "git" as const,
              repo,
              branch,
              ...(token.trim() ? { token: token.trim() } : {}),
            }
          : { type: "image" as const, image: image.trim() };

      const payload: Record<string, unknown> = {
        name,
        source,
        port,
        volumePath,
        buildCommand,
        startCommand,
      };
      if (buildContext.trim()) payload.buildContext = buildContext.trim();
      if (dockerfile.trim()) payload.dockerfile = dockerfile.trim();
      if (healthPath.trim()) payload.healthPath = healthPath.trim();

      const { project } = await api.post("/api/projects", payload);
      if (Object.keys(env).length > 0) {
        await api.put(`/api/projects/${project.id}/env`, { env });
      }
      onCreated(project);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="modal"
        role="presentation"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>New Project</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <form onSubmit={submit} className="modal-form">
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

          <div className="field-row">
            <label className="field">
              <span>Project Slug</span>
              <input
                placeholder="my-app"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              {slugPreview && (
                <span className="field-hint">
                  Live URL: {appUrlFor({ name: slugPreview }, node)}
                </span>
              )}
            </label>
            <label className="field" style={{ maxWidth: 130 }}>
              <span>Container Port</span>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                min={1}
                max={65535}
              />
            </label>
          </div>

          {sourceType === "git" ? (
            <>
              <div className="field-row">
                <label className="field">
                  <span>Git Repository</span>
                  <input
                    placeholder="owner/repo or https://git.example/org/app.git"
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    required
                  />
                </label>
                <label className="field" style={{ maxWidth: 150 }}>
                  <span>Branch</span>
                  <input
                    placeholder="main"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                  />
                </label>
              </div>

              <label className="field">
                <span>
                  Read-Only Git Token <em>(optional — for private repositories)</em>
                </span>
                <input
                  type="password"
                  placeholder="ghp_… or glpat-… (encrypted at rest, never shown again)"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="new-password"
                />
              </label>

              <div className="field-row">
                <label className="field">
                  <span>
                    Build Context <em>(optional subdirectory)</em>
                  </span>
                  <input
                    placeholder=". or apps/web"
                    value={buildContext}
                    onChange={(e) => setBuildContext(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>
                    Dockerfile <em>(optional; Railpack if absent)</em>
                  </span>
                  <input
                    placeholder="Dockerfile"
                    value={dockerfile}
                    onChange={(e) => setDockerfile(e.target.value)}
                  />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>
                    Build Command <em>(optional)</em>
                  </span>
                  <input
                    placeholder="Auto-detected by Railpack"
                    value={buildCommand}
                    onChange={(e) => setBuildCommand(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>
                    Start Command <em>(optional)</em>
                  </span>
                  <input
                    placeholder="Auto-detected by Railpack"
                    value={startCommand}
                    onChange={(e) => setStartCommand(e.target.value)}
                  />
                </label>
              </div>
            </>
          ) : (
            <label className="field">
              <span>OCI Image Reference</span>
              <input
                placeholder="nginxinc/nginx-unprivileged:alpine or ghcr.io/org/app:1.0"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                required
              />
              <span className="field-hint">
                Pulled inside the sandbox; the resolved sha256 digest is pinned on each deployment
                for exact rollback.
              </span>
            </label>
          )}

          <div className="field-row">
            <label className="field">
              <span>
                Health Probe Path <em>(optional)</em>
              </span>
              <input
                placeholder="/ or /health"
                value={healthPath}
                onChange={(e) => setHealthPath(e.target.value)}
              />
            </label>
            <label className="field">
              <span>
                Persistent Volume Mount <em>(optional)</em>
              </span>
              <input
                placeholder="/data (leave empty for stateless)"
                value={volumePath}
                onChange={(e) => setVolumePath(e.target.value)}
              />
            </label>
          </div>
          <span className="field-hint">
            Release strategy:{" "}
            {volumePath.trim()
              ? "Stop-then-start (single-writer volume safety)"
              : "Blue/green zero-downtime"}
          </span>

          <div className="field">
            <span>
              Environment Variables <em>(encrypted at rest)</em>
            </span>
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
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? <span className="spinner-sm" /> : "Create Project →"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
