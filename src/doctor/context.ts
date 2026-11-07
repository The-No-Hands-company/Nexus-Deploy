import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { config } from "../lib/config.js";
import { childEnv } from "../lib/docker.js";
import type { Ctx, DockerResult, Listener } from "./types.js";

function run(cmd: string, args: string[], timeoutMs: number): Promise<DockerResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // The same forced environment real builds get: the sandbox daemon, nothing else.
      env: childEnv(cmd, config.sandboxDockerHost),
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    proc.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function listen(host: string): Promise<Listener> {
  return new Promise((resolve, reject) => {
    let accepted = 0;
    const server = net.createServer((socket) => {
      accepted++;
      socket.destroy();
    });
    server.on("error", reject);
    server.listen(0, host, () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        accepted: () => accepted,
        close: () => server.close(),
      });
    });
  });
}

export function realContext(limits: Ctx["limits"]): Ctx {
  return {
    sandboxHost: config.sandboxDockerHost,
    storagePath: config.sandboxStoragePath,
    expectedStorageGb: Number(process.env["SANDBOX_STORAGE_SIZE_GB"] ?? 0),
    limits,
    probeImage: process.env["DOCTOR_PROBE_IMAGE"] ?? "busybox:1.36",
    docker: (args, timeoutMs = 30_000) => run("docker", args, timeoutMs),
    fileExists: (p) => fs.existsSync(p),
    device: (p) => {
      try {
        return fs.statSync(p).dev;
      } catch {
        return null;
      }
    },
    fsUsage: (p) => {
      try {
        const s = fs.statfsSync(p);
        return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
      } catch {
        return null;
      }
    },
    hostAddresses: () =>
      Object.values(os.networkInterfaces())
        .flat()
        .filter((i): i is os.NetworkInterfaceInfo => Boolean(i))
        .filter((i) => i.family === "IPv4" && !i.internal)
        .map((i) => i.address),
    listen,
  };
}
