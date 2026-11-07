import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { dashboardHomeUrl, fetchSession, isEmbedded } from "./api";
import { OperatorPanel } from "./components/OperatorPanel";
import { ProjectDetail } from "./components/ProjectDetail";
import { ProjectsList } from "./components/ProjectsList";
import { NotAMemberState, NotSignedIn, UnreachableState } from "./components/StatusStates";
import type { NodeInfo, SessionResult, User } from "./types";

function Sidebar({
  user,
  operator,
  node,
  embedded,
  onLogout,
  counts,
}: {
  user: User;
  operator: boolean;
  node: NodeInfo;
  embedded: boolean;
  onLogout: () => void;
  counts: { total: number; live: number; building: number };
}) {
  const navigate = useNavigate();
  const loc = useLocation();
  const inOperators = loc.pathname.startsWith("/operators");

  return (
    <aside className="sidebar">
      {!embedded && (
        <div className="sidebar-brand">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="brand-mark">⬡</span>
            <div>
              <div className="brand-name">Nexus Deploy</div>
              <div className="brand-sub">{node.controlHost}</div>
            </div>
          </div>
          <a
            className="sidebar-home-link"
            href={dashboardHomeUrl(node)}
            title="Back to Nexus Dashboard"
          >
            Nexus ↗
          </a>
        </div>
      )}

      <nav className="sidebar-nav">
        <button
          type="button"
          className={`nav-item ${!inOperators ? "active" : ""}`}
          onClick={() => navigate("/")}
        >
          <span>⬡</span> Projects
          {counts.total > 0 && <span className="nav-count">{counts.total}</span>}
        </button>
        {operator && (
          <button
            type="button"
            className={`nav-item ${inOperators ? "active" : ""}`}
            onClick={() => navigate("/operators")}
          >
            <span>🛡</span> Operators
          </button>
        )}
      </nav>

      {counts.total > 0 && (
        <div className="sidebar-stats">
          {counts.live > 0 && (
            <div className="sidebar-stat">
              <span className="stat-dot live" />
              <span>{counts.live} live</span>
            </div>
          )}
          {counts.building > 0 && (
            <div className="sidebar-stat">
              <span className="stat-dot building" />
              <span>{counts.building} building</span>
            </div>
          )}
          {counts.live === 0 && counts.building === 0 && (
            <div className="sidebar-stat">
              <span className="stat-dot idle" />
              <span>all stopped</span>
            </div>
          )}
        </div>
      )}

      <div className="sidebar-help">
        <div className="help-title">How Deploy Works</div>
        <ol className="help-steps">
          <li>Push to Git or pick an OCI image</li>
          <li>Railpack or Dockerfile builds in sandbox</li>
          <li>Blue/green probe switches live HTTPS route</li>
        </ol>
      </div>

      {!embedded && (
        <div className="sidebar-user">
          <div className="role-badge">{operator ? "operator" : user.role || "member"}</div>
          <div className="email">{user.email || user.username || user.id}</div>
          <button type="button" className="logout-btn" onClick={onLogout}>
            Sign out
          </button>
        </div>
      )}
    </aside>
  );
}

function AppShell({
  wsToken,
  user,
  operator,
  node,
  onLogout,
}: {
  wsToken: string;
  user: User;
  operator: boolean;
  node: NodeInfo;
  onLogout: () => void;
}) {
  const [counts, setCounts] = useState({ total: 0, live: 0, building: 0 });
  const embedded = isEmbedded();

  return (
    <div className="shell">
      <Sidebar
        user={user}
        operator={operator}
        node={node}
        embedded={embedded}
        onLogout={onLogout}
        counts={counts}
      />
      <main className="main">
        <Routes>
          <Route path="/" element={<ProjectsList node={node} onCountsChange={setCounts} />} />
          <Route path="/projects/:id" element={<ProjectDetail wsToken={wsToken} node={node} />} />
          {operator && <Route path="/operators" element={<OperatorPanel />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<SessionResult | null>(null);

  const checkSession = useCallback(async () => {
    try {
      localStorage.removeItem("nexus-token");
    } catch {
      /* private mode */
    }
    const next = await fetchSession();
    setSession(next);
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  // Re-check automatically when connectivity or tab visibility returns after a drop.
  useEffect(() => {
    if (session?.kind !== "unreachable") return;
    const onRecover = () => {
      if (document.visibilityState === "visible") void checkSession();
    };
    window.addEventListener("online", onRecover);
    document.addEventListener("visibilitychange", onRecover);
    return () => {
      window.removeEventListener("online", onRecover);
      document.removeEventListener("visibilitychange", onRecover);
    };
  }, [session?.kind, checkSession]);

  function logout() {
    window.location.href = "/api/auth/logout";
  }

  if (!session) {
    return (
      <div className="loading">
        <div className="spinner" /> Nexus Deploy
      </div>
    );
  }
  if (session.kind === "unreachable") {
    return <UnreachableState onRetry={checkSession} />;
  }
  if (session.kind === "signed-out") {
    return (
      <BrowserRouter>
        <NotSignedIn />
      </BrowserRouter>
    );
  }
  if (session.kind === "not-a-member") {
    return <NotAMemberState user={session.user} reason={session.reason} onLogout={logout} />;
  }

  return (
    <BrowserRouter>
      <AppShell
        wsToken={session.wsToken}
        user={session.user}
        operator={session.access.operator}
        node={session.node}
        onLogout={logout}
      />
    </BrowserRouter>
  );
}
