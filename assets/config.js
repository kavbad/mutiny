// Where the pages find the Worker. Local dev talks to `wrangler dev` on 8787.
window.MUTINY_API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname))
  ? "http://localhost:8787"
  : "https://mutiny-api.REPLACE_ME.workers.dev";
