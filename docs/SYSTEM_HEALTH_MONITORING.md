# System health
GET /api/live reports process liveness. GET /api/health and GET /api/ready check MySQL and return generic ok/unavailable status (503 on failure). Public endpoints do not disclose infrastructure addresses, credentials or service detail.

Remaining: authorized dashboard, bounded dependency probe timeouts, Redis/SMTP/storage/queue/websocket probes, CPU/memory/disk metrics, uptime history, incident alerts and Prometheus/Grafana integration. Database readiness alone is not complete application readiness.
