import { existsSync } from "node:fs";

// Load .env once for the server process (Vite only exposes VITE_* vars to
// import.meta.env, and these secrets must never reach the client bundle).
let loaded = false;
function load() {
  if (loaded) return;
  loaded = true;
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file);
      } catch {
        // ignore malformed env files; requireEnv() reports what is missing
      }
    }
  }
}

export function requireEnv(name: string): string {
  load();
  const value = process.env[name];
  if (!value) {
    const hint = name === "ANTHROPIC_API_KEY" ? "Add it to .env and restart the server." : "Run `npm run setup` first.";
    throw new Error(`Missing required environment variable ${name}. ${hint}`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  load();
  return process.env[name] || undefined;
}
