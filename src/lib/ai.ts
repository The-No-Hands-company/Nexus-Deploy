import { config } from "./config.js";

export type NexusAiIntegrationContract = {
  enabled: boolean;
  provider: "nexus-ai";
  baseUrl: string | null;
  completionPath: string;
  auth: "none" | "bearer";
  model: string;
  purpose: string;
};

export type DeployAssistantRequest = {
  prompt: string;
  context?: Record<string, unknown>;
  model?: string;
  temperature?: number;
};

export type DeployAssistantResponse = {
  suggestion: string;
  raw?: unknown;
};

export function describeNexusAiIntegration(): NexusAiIntegrationContract {
  const enabled = Boolean(config.nexusAiUrl.trim());
  return {
    enabled,
    provider: "nexus-ai",
    baseUrl: enabled ? config.nexusAiUrl.replace(/\/$/, "") : null,
    completionPath: config.nexusAiCompletionPath,
    auth: config.nexusAiApiKey ? "bearer" : "none",
    model: "nexus-deploy-assistant",
    purpose: "deployment planning, command recommendations, and remediation guidance",
  };
}

export async function requestDeployAssistantSuggestion(input: DeployAssistantRequest): Promise<DeployAssistantResponse> {
  const baseUrl = config.nexusAiUrl.replace(/\/$/, "");
  if (!baseUrl) {
    throw new Error("Nexus AI integration is not configured");
  }

  const endpoint = `${baseUrl}${config.nexusAiCompletionPath.startsWith("/") ? "" : "/"}${config.nexusAiCompletionPath}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(config.nexusAiApiKey ? { authorization: `Bearer ${config.nexusAiApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: input.model ?? "nexus-deploy-assistant",
      messages: [
        {
          role: "system",
          content: "You are Nexus Deploy assistant. Return concise and actionable deployment guidance.",
        },
        {
          role: "user",
          content: `${input.prompt}\n\nContext: ${JSON.stringify(input.context ?? {})}`,
        },
      ],
      temperature: typeof input.temperature === "number" ? input.temperature : 0.2,
    }),
  });

  if (!response.ok) {
    throw new Error(`Nexus AI upstream returned ${response.status}`);
  }

  const raw = (await response.json().catch(() => null)) as any;
  const suggestion =
    raw?.choices?.[0]?.message?.content ??
    raw?.output_text ??
    raw?.result ??
    "Nexus AI returned no suggestion text.";

  return {
    suggestion: String(suggestion),
    raw,
  };
}
