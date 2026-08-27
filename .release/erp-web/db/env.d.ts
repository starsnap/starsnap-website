declare namespace Cloudflare {
  interface Env {
    DATABASE_URL: string;
    PGPOOL_MAX?: string;
    PGSSL?: string;
    ERP_EMBEDDING_WORKER_TOKEN?: string;
    EAT_API_SERVICE_KEY?: string;
    EAT_CACHE_TTL_MINUTES?: string;
  }
}
