# Nexus Deploy

## Purpose

This directory contains Nexus Deploy, a Railway-inspired deployment system for The No Hands Company.

## Conventions

- Keep the app lean and self-contained.
- Prefer TypeScript, plain React, and simple persistence over heavy abstractions.
- Store runtime state under `DATA_DIR` and keep `/workspace` mount-friendly.
- Use AES-GCM for stored secrets; never write plaintext secrets to disk.
- Keep API responses small and dashboard-friendly.
- When updating files, preserve the deploy flow: auth, projects, deployments, logs, and the dashboard.
