export function summarizeBuild(repo: string) {
  return [
    `[build] cloning ${repo}`,
    "[build] detected Dockerfile",
    "[build] building React dashboard",
    "[build] installing Python dependencies",
    "[build] ready to deploy",
  ];
}
