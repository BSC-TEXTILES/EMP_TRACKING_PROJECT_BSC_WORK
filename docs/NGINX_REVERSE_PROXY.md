# NGINX reverse proxy
See deploy/nginx.conf. Replace the hostname and certificate paths, then run nginx -t on the deployment host before reloading. Configuration is supplied but has not been executed against an installed NGINX service in this workspace.

The template terminates TLS, redirects HTTP, forwards the SPA/API to port 4000, supports Socket.IO upgrades, caps requests and limits connections/rates. /uploads is blocked; authorized downloads use /api/files/:id. The application provides immutable caching for built static assets. Configure APP_ORIGIN/APP_URL for the HTTPS origin and TRUST_PROXY=loopback only when the proxy and API share a host. The proxy overwrites forwarded IP headers. Bind/firewall backend, MySQL, Redis and ClamAV so only the intended private services can reach them.

Supply certificates and secrets outside source control. Test HTTPS redirect, authenticated downloads, API requests, websocket upgrade/reconnect and upload-size rejection before release. Tune IP limits for shared-office networks.
