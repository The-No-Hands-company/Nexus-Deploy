import { type CSSProperties, useEffect, useRef, useState } from "react";
import { isEmbedded } from "../api";
import type { User } from "../types";

const STATUS_VARS: Record<string, string> = {
  live: "var(--success)",
  active: "var(--success)",
  building: "var(--warn)",
  queued: "var(--info)",
  failed: "var(--danger)",
  suspended: "var(--danger)",
  stopped: "var(--text3)",
  idle: "var(--text3)",
  cancelled: "var(--text3)",
};

export function Badge({ status }: { status: string }) {
  return (
    <span
      className="badge"
      style={{ "--badge-color": STATUS_VARS[status] ?? "var(--text3)" } as CSSProperties}
    >
      <span className="dot" />
      {status}
    </span>
  );
}

export function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-pill">
      <span className="stat-pill-label">{label}</span>
      <span className="stat-pill-val">{value}</span>
    </div>
  );
}

export function NotSignedIn() {
  const embedded = isEmbedded();
  const returnPath = `${window.location.pathname}${window.location.search}`;
  const loginHref = `/api/auth/login?redirect=${encodeURIComponent(returnPath)}`;
  return (
    <div className="auth-bg">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">⬡</span>
          <div>
            <div className="brand-name">Nexus Deploy</div>
            <div className="brand-sub">The No Hands Company</div>
          </div>
        </div>
        <p style={{ color: "var(--text2)", fontSize: 14, lineHeight: 1.55, marginBottom: 20 }}>
          Nexus Deploy uses your ecosystem account. Sign in once to deploy Git repositories and
          container images on this node.
        </p>
        <a
          className="btn-primary"
          href={loginHref}
          target={embedded ? "_top" : undefined}
          style={{ width: "100%" }}
        >
          Sign in with Nexus →
        </a>
        <div className="auth-note">Free forever · No billing · Open source (AGPL-3.0)</div>
      </div>
    </div>
  );
}

export function UnreachableState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="auth-bg">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">⬡</span>
          <div>
            <div className="brand-name">Nexus Deploy</div>
            <div className="brand-sub">Connection interrupted</div>
          </div>
        </div>
        <p style={{ color: "var(--text2)", fontSize: 14, lineHeight: 1.55, marginBottom: 20 }}>
          The control plane or identity service could not be reached. Your session has not been
          cleared — retry when the connection recovers.
        </p>
        <button type="button" className="btn-primary" onClick={onRetry} style={{ width: "100%" }}>
          Retry connection
        </button>
      </div>
    </div>
  );
}

export function NotAMemberState({
  user,
  reason,
  onLogout,
}: {
  user: User;
  reason: "not_a_member" | "suspended";
  onLogout: () => void;
}) {
  return (
    <div className="auth-bg">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">⬡</span>
          <div>
            <div className="brand-name">Nexus Deploy</div>
            <div className="brand-sub">
              {reason === "suspended" ? "Access suspended" : "Invite-only node"}
            </div>
          </div>
        </div>
        <p style={{ color: "var(--text2)", fontSize: 14, lineHeight: 1.55, marginBottom: 14 }}>
          {reason === "suspended"
            ? "Your Nexus Deploy membership on this node is currently suspended. Contact a node operator if you believe this is a mistake."
            : "This node shares compute among invited ecosystem members. Ask a node operator to grant your account access."}
        </p>
        <div
          className="info-card"
          style={{ background: "var(--surface2)", padding: 12, marginBottom: 16 }}
        >
          <div className="info-row">
            <span>Signed in as</span>
            <span className="mono">{user.username || user.email || user.id}</span>
          </div>
          <div className="info-row" style={{ marginTop: 6 }}>
            <span>Account ID</span>
            <span className="mono">{user.id}</span>
          </div>
        </div>
        <button type="button" className="btn-ghost" onClick={onLogout} style={{ width: "100%" }}>
          Sign out
        </button>
      </div>
    </div>
  );
}

export function LogTerminal({
  deploymentId,
  projectId,
  wsToken,
  mode,
}: {
  deploymentId?: string;
  projectId?: string;
  wsToken: string;
  mode: "build" | "container";
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [status, setStatus] = useState<string>("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    setDone(false);
    setStatus("");

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const tokenParam = wsToken ? `&token=${encodeURIComponent(wsToken)}` : "";
    const wsUrl =
      mode === "build"
        ? `${proto}://${window.location.host}/api/log-stream?deploymentId=${deploymentId}${tokenParam}`
        : `${proto}://${window.location.host}/api/container-stream?projectId=${projectId}${tokenParam}`;

    const ws = new WebSocket(wsUrl);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "log" || msg.type === "info" || msg.type === "error") {
          setLines((prev) => [...prev, msg.line]);
        } else if (msg.type === "done") {
          setDone(true);
          setStatus(msg.status);
        }
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onerror = () => setLines((prev) => [...prev, "[nexus] WebSocket error"]);
    return () => ws.close();
  }, [deploymentId, projectId, wsToken, mode]);

  useEffect(() => {
    if (lines.length === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines.length]);

  return (
    <div className="log-terminal">
      <div className="log-header">
        <span className={`log-dot ${done ? "done" : "pulsing"}`} />
        <span>{mode === "build" ? "Build Output" : "Live Container Logs"}</span>
        {done && (
          <span className={`log-done ${status}`}>
            {status === "live" ? "✓ Build succeeded" : `✗ Build ${status}`}
          </span>
        )}
      </div>
      <div className="log-body">
        {lines.length === 0 && <div className="log-empty">Waiting for output…</div>}
        {lines.map((line, i) => (
          <div
            key={`${i}-${line.slice(0, 24)}`}
            className={`log-line ${
              line.includes("ERROR") || line.includes("failed")
                ? "err"
                : line.startsWith("[nexus]")
                  ? "nexus"
                  : ""
            }`}
          >
            {line}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
