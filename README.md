# rustix.me-test

Dedicated Rustix.me NodeJS node runtime for Container Test.

## Phase 1 target

Run one native VLESS-over-WebSocket endpoint on the Rustix primary allocation.

Current panel values:

- Runtime: NodeJS 24
- Public host: `f1.rustix.me`
- Primary allocation: `37972`
- Secondary allocation: `34822`
- Main file: `index.js`

The runtime does **not** hard-code the listen port. It prefers `SERVER_PORT`, then `PORT`, and uses 37972 only as a final current-panel fallback.

## Native endpoint

The app serves HTTP and VLESS/WS on the same primary port:

- `GET /health`
- `GET /<generated-token>/node`
- `GET /<generated-token>/sub`
- `GET /<generated-token>/sub64`
- VLESS WebSocket on a generated persistent path

Identity is persisted under `/home/container/.rustix-node/`, so a normal restart should retain UUID, WS path and subscription token.

## Railway registry

Registry support is already included but remains inactive unless a token is available.

Preferred local secret file:

`/home/container/registry_token.txt`

The file must contain only the Railway registry token on one line. When present, the node registers as:

- provider: `rustix`
- stable node_id: `rustix-01-native`
- endpoint: `POST /api/v1/register`
- heartbeat: `POST /api/v1/heartbeat`

Default registry:

`https://subscription-server-v2-production.up.railway.app`

No Railway code change is required.

## Rustix panel

Use the repository directly:

- Repository: `https://github.com/dulangd/rustix.me-test.git`
- Branch: `main`
- Main file: `index.js`
- Additional Node packages: empty
- Additional arguments: empty
- Auto update: off during validation

## Acceptance order

1. Start on the primary allocation.
2. Verify `http://f1.rustix.me:37972/health`.
3. Copy the printed VLESS link into v2rayN and verify real outbound HTTPS traffic.
4. Restart the server and verify the same UUID/path still works.
5. Only then add `registry_token.txt`, restart once, and confirm `REGISTRY_READY` and one Railway record `rustix-01-native`.
6. After native stability is proven, evaluate Rustix subdomain/TLS before deciding whether Cloudflare Tunnel adds value.
7. Keep port 34822 unused until the primary endpoint is proven.

## Phase 2 / Phase 3 decision

Cloudflare Tunnel is not required for the native node. It is only worth adding if Rustix's own subdomain mapping cannot provide a stable HTTPS/WSS 443 endpoint and a second TLS ingress is useful.

The secondary port 34822 should not merely duplicate 37972. After testing its raw TCP behavior it can be assigned to one of these roles, in priority order:

1. a distinct raw-TCP protocol endpoint such as VLESS REALITY, if Rustix permits a standalone binary and raw TCP;
2. a dedicated local origin for Cloudflare Tunnel, isolating CF ingress from the native node;
3. a second independent VLESS/WS identity for redundancy/testing.

Do not register a second logical Railway node until the second endpoint is independently usable by a real client.
