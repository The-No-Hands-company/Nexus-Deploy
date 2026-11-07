import { useCallback } from "react";
import type { NodeInfo, SessionResult } from "./types.js";

/** True when rendered inside the Nexus shell iframe (?embed=1). */
export function isEmbedded(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get("embed") === "1";
}

/** Standalone link back to the Nexus shell home on the node's base domain. */
export function dashboardHomeUrl(node?: NodeInfo | null): string {
  const domain =
    node?.baseDomain || window.location.hostname.replace(/^deploy\./, "") || "localhost";
  if (domain === "localhost" || domain === "127.0.0.1") return "/";
  return `https://app.${domain}`;
}

/** Public HTTPS origin for a live deployed app. */
export function appUrlFor(project: { name: string }, node?: NodeInfo | null): string {
  const baseDomain =
    node?.baseDomain || window.location.hostname.replace(/^deploy\./, "") || "localhost";
  const pattern = node?.hostPattern || "{slug}.{BASE_DOMAIN}";
  const host = pattern.replace("{slug}", project.name).replace("{BASE_DOMAIN}", baseDomain);
  return `https://${host}`;
}

/** Control-plane short link (<controlHost>/<slug>) that 302-redirects to the app. */
export function shortLinkUrlFor(project: { name: string }, node?: NodeInfo | null): string {
  const controlHost = node?.controlHost || window.location.host;
  return `https://${controlHost}/${project.name}`;
}

/**
 * Ask the control plane who is signed in.
 *
 * Per docs/THEME-GUIDE.md §5, a network failure or 5xx is "unreachable", never
 * "signed-out": only a real 401 means signed out.
 */
export async function fetchSession(): Promise<SessionResult> {
  try {
    const res = await fetch("/api/me", { credentials: "include" });
    if (res.status === 401) return { kind: "signed-out" };
    if (!res.ok) return { kind: "unreachable" };
    const body = await res.json();
    const user = body?.user;
    if (!user) return { kind: "signed-out" };
    const node: NodeInfo = body?.node ?? {
      baseDomain: window.location.hostname.replace(/^deploy\./, "") || "localhost",
      controlHost: window.location.host,
      hostPattern: "{slug}.{BASE_DOMAIN}",
    };
    if (body?.access?.member === false) {
      return {
        kind: "not-a-member",
        user,
        reason: body.access.reason === "suspended" ? "suspended" : "not_a_member",
        node,
      };
    }
    return {
      kind: "signed-in",
      user,
      access: { member: true, operator: Boolean(body?.access?.operator) },
      node,
      wsToken: typeof body?.wsToken === "string" ? body.wsToken : "",
    };
  } catch {
    return { kind: "unreachable" };
  }
}

export function useApi() {
  const req = useCallback(async (method: string, path: string, body?: unknown) => {
    const res = await fetch(path, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }, []);

  return {
    get: useCallback((p: string) => req("GET", p), [req]),
    post: useCallback((p: string, b?: unknown) => req("POST", p, b), [req]),
    put: useCallback((p: string, b?: unknown) => req("PUT", p, b), [req]),
    patch: useCallback((p: string, b?: unknown) => req("PATCH", p, b), [req]),
    del: useCallback((p: string) => req("DELETE", p), [req]),
  };
}
