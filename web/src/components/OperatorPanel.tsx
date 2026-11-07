import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useApi } from "../api";
import type { AuditEntry, MemberRecord } from "../types";
import { Badge } from "./StatusStates";

export function OperatorPanel() {
  const api = useApi();
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [authUserId, setAuthUserId] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const [mRes, aRes] = await Promise.all([
      api.get("/api/admin/members"),
      api.get("/api/admin/audit"),
    ]);
    setMembers(mRes.members ?? []);
    setAudit(aRes.audit ?? []);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function grant(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.post("/api/admin/members", {
        authUserId: authUserId.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setAuthUserId("");
      setLabel("");
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to grant member");
    } finally {
      setLoading(false);
    }
  }

  async function toggleStatus(m: MemberRecord) {
    const next = m.status === "active" ? "suspended" : "active";
    try {
      await api.patch(`/api/admin/members/${encodeURIComponent(m.authUserId)}`, { status: next });
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update member");
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Operators</h1>
          <p className="subtitle">
            Manage invited ecosystem members and inspect the 30-day zero-IP audit trail.
          </p>
        </div>
      </div>

      <div className="overview-grid">
        <div className="info-card">
          <h3>Grant Member Access</h3>
          <form onSubmit={grant} className="settings-form">
            <label className="field">
              <span>Nexus-Auth Account ID</span>
              <input
                placeholder="usr-xxxxxxxx or username"
                value={authUserId}
                onChange={(e) => setAuthUserId(e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>
                Label <em>(optional)</em>
              </span>
              <input
                placeholder="Ada Lovelace"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            {error && <div className="form-error">{error}</div>}
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? <span className="spinner-sm" /> : "+ Grant Member Access"}
            </button>
          </form>
        </div>

        <div className="info-card">
          <h3>Invited Members ({members.length})</h3>
          {members.length === 0 ? (
            <p className="muted">No members recorded yet.</p>
          ) : (
            <div className="deploy-list">
              {members.map((m) => (
                <div key={m.authUserId} className="deploy-row">
                  <div className="deploy-row-left" style={{ cursor: "default" }}>
                    <Badge status={m.status} />
                    <span className="mono">{m.authUserId}</span>
                    {m.label && <span>({m.label})</span>}
                    <span className="trigger-tag">{m.role}</span>
                  </div>
                  <div className="deploy-row-actions">
                    <span className="muted">
                      by {m.grantedBy} · {new Date(m.grantedAt).toLocaleDateString()}
                    </span>
                    {m.role !== "owner" && (
                      <button type="button" className="btn-ghost" onClick={() => toggleStatus(m)}>
                        {m.status === "active" ? "Suspend" : "Reactivate"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="info-card" style={{ marginTop: 18 }}>
        <h3>30-Day Audit Log</h3>
        <p className="field-hint" style={{ marginBottom: 12 }}>
          Records only account ID, action, subject, and timestamp. Visitor IP addresses and user
          agents are never read or stored.
        </p>
        {audit.length === 0 ? (
          <p className="muted">No audit events recorded.</p>
        ) : (
          <div className="deploy-list" style={{ maxHeight: 380, overflowY: "auto" }}>
            {audit.map((entry, idx) => (
              <div key={`${entry.at}-${idx}`} className="deploy-row">
                <div className="deploy-row-left" style={{ cursor: "default" }}>
                  <span className="trigger-tag">{entry.action}</span>
                  <span className="mono">{entry.subject}</span>
                </div>
                <div className="deploy-row-actions">
                  <span className="mono">{entry.actor}</span>
                  <span className="muted">{new Date(entry.at).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
