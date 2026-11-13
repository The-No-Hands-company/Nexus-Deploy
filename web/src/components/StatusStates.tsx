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

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r/g, "");
}

function classifyLine(line: string): string {
  if (line.startsWith("[nexus]")) return "nexus";
  const lo = line.toLowerCase();
  if (lo.includes("error") || lo.includes("failed") || lo.includes("fatal")) return "err";
  if (lo.includes("warning") || /\bwarn\b/.test(lo)) return "warn";
  if (/^(step \d+\/\d+|---> |#\d+ )/.test(line)) return "step";
  return "";
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
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    setDone(false);
    setStatus("");
    setAutoScroll(true);

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
          setLines((prev) => [...prev, stripAnsi(msg.line)]);
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
    if (!autoScroll) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines.length, autoScroll]);

  function onScroll() {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAutoScroll(atBottom);
  }

  function copyAll() {
    navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const doneLabel =
    mode === "container"
      ? "[connection closed]"
      : status === "live"
        ? "✓ succeeded"
        : `✗ ${status}`;

  return (
    <div className="log-terminal">
      <div className="log-header">
        <span className={`log-dot ${done ? "" : "pulsing"}`} />
        <span>{mode === "build" ? "Build Output" : "Live Logs"}</span>
        {lines.length > 0 && <span className="log-count">{lines.length} lines</span>}
        {done && <span className={`log-done ${status}`}>{doneLabel}</span>}
        <div className="log-controls">
          <button
            type="button"
            className={`log-btn ${autoScroll ? "active" : ""}`}
            onClick={() => {
              setAutoScroll(true);
              bottomRef.current?.scrollIntoView({ behavior: "smooth" });
            }}
            title="Follow new output"
          >
            ↓ follow
          </button>
          <button type="button" className="log-btn" onClick={copyAll}>
            {copied ? "✓ copied" : "copy"}
          </button>
        </div>
      </div>
      <div className="log-body" ref={bodyRef} onScroll={onScroll}>
        {lines.length === 0 && <div className="log-empty">Waiting for output…</div>}
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
          <div key={i} className={`log-line ${classifyLine(line)}`}>
            {line}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
