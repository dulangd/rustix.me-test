'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.HOME || '/home/container';
const STATE_DIR = path.resolve(process.env.STATE_DIR || path.join(HOME, '.rustix-node'));
const IDENTITY_FILE = path.join(STATE_DIR, 'identity.json');
const OUTPUT_FILE = path.resolve(process.env.OUTPUT_FILE || path.join(HOME, 'deployment-output.txt'));
const TOKEN_FILE = path.resolve(process.env.REGISTRY_TOKEN_FILE || path.join(HOME, 'registry_token.txt'));

function validPort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writePrivate(file, text) {
  ensureDir(path.dirname(file));
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function normalizePath(value) {
  const v = String(value || '').trim();
  if (!v) throw new Error('path cannot be empty');
  return v.startsWith('/') ? v : '/' + v;
}

function loadIdentity() {
  ensureDir(STATE_DIR);
  let old = {};
  try { old = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8')); } catch {}

  const identity = {
    uuid: process.env.UUID || old.uuid || crypto.randomUUID(),
    wsPath: normalizePath(process.env.WSPATH || old.wsPath || '/ws-' + randomToken(9)),
    subToken: process.env.SUB_TOKEN || old.subToken || randomToken(24),
    nodeId: process.env.NODE_ID || old.nodeId || 'rustix-01-native'
  };

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.uuid)) {
    throw new Error('UUID must be a UUID v4');
  }
  if (identity.subToken.length < 20) throw new Error('SUB_TOKEN too short');
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(identity.nodeId)) throw new Error('NODE_ID invalid');

  writePrivate(IDENTITY_FILE, JSON.stringify(identity, null, 2) + '\n');
  return identity;
}

function readRegistryToken() {
  const envToken = String(process.env.RUSTIX_REGISTER_TOKEN || process.env.REGISTRY_TOKEN || '').trim();
  if (envToken) return envToken;
  try {
    const fileToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (fileToken) {
      try { fs.chmodSync(TOKEN_FILE, 0o600); } catch {}
      return fileToken;
    }
  } catch {}
  return '';
}

const identity = loadIdentity();
const listenHost = process.env.LISTEN_HOST || '0.0.0.0';
const listenPort = validPort(process.env.SERVER_PORT, validPort(process.env.PORT, 37972));
const publicHost = String(process.env.PUBLIC_HOST || 'f1.rustix.me').trim();
const publicPort = validPort(process.env.PUBLIC_PORT, listenPort);
const publicTls = envBool('PUBLIC_TLS', false);
const publicWsHost = String(process.env.PUBLIC_WS_HOST || publicHost).trim();
const allowPrivateTargets = envBool('ALLOW_PRIVATE_TARGETS', false);

const registryBase = String(process.env.REGISTRY_URL || 'https://subscription-server-v2-production.up.railway.app').replace(/\/$/, '');
const registerPath = normalizePath(process.env.REGISTRY_REGISTER_PATH || '/api/v1/register');
const heartbeatPath = normalizePath(process.env.REGISTRY_HEARTBEAT_PATH || '/api/v1/heartbeat');
const heartbeatMinutes = Math.max(1, Number(process.env.REGISTRY_HEARTBEAT_MINUTES || 10) || 10);
let registryToken = readRegistryToken();

let countryCode = '';
let egressIp = '';
let nodeName = String(process.env.NODE_NAME || 'Rustix-01-Native').trim();

const subPath = '/' + identity.subToken + '/sub';
const sub64Path = '/' + identity.subToken + '/sub64';
const nodePath = '/' + identity.subToken + '/node';
const expectedUuid = Buffer.from(identity.uuid.replace(/-/g, ''), 'hex');

function hostForUri(host) {
  return net.isIP(host) === 6 ? '[' + host + ']' : host;
}

function refreshNodeName() {
  const base = String(process.env.NODE_NAME || 'Rustix-01-Native').trim().replace(/^[A-Z]{2}-/i, '');
  nodeName = countryCode ? countryCode + '-' + base : base;
}

function nodeUri() {
  const q = new URLSearchParams({
    encryption: 'none',
    security: publicTls ? 'tls' : 'none',
    type: 'ws',
    path: identity.wsPath,
    host: publicWsHost
  });
  if (publicTls) {
    q.set('sni', publicWsHost);
    q.set('fp', 'chrome');
    q.set('alpn', 'http/1.1');
  }
  return 'vless://' + identity.uuid + '@' + hostForUri(publicHost) + ':' + publicPort + '?' + q.toString() + '#' + encodeURIComponent(nodeName);
}

function publicBase() {
  const scheme = publicTls ? 'https' : 'http';
  const defaultPort = (publicTls && publicPort === 443) || (!publicTls && publicPort === 80);
  return scheme + '://' + hostForUri(publicHost) + (defaultPort ? '' : ':' + publicPort);
}

function writeOutput() {
  const text = [
    'Rustix Native Node',
    '==================',
    'status=ready',
    'provider=rustix',
    'listen=' + listenHost + ':' + listenPort,
    'public=' + publicHost + ':' + publicPort,
    'tls=' + (publicTls ? 'on' : 'off'),
    'country=' + (countryCode || 'pending'),
    'egress_ip=' + (egressIp || 'pending'),
    'node_id=' + identity.nodeId,
    'ws_path=' + identity.wsPath,
    '',
    'VLESS=' + nodeUri(),
    'SUB=' + publicBase() + subPath,
    'SUB64=' + publicBase() + sub64Path,
    ''
  ].join('\n');
  writePrivate(OUTPUT_FILE, text);
}

async function detectGeo() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
      headers: { 'user-agent': 'rustix-node/1.0' },
      signal: ctl.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.text();
    const m = Object.fromEntries(
      body.split(/\r?\n/).filter(Boolean).map(line => {
        const p = line.indexOf('=');
        return p > 0 ? [line.slice(0, p), line.slice(p + 1)] : [line, ''];
      })
    );
    if (/^[A-Z]{2}$/.test(String(m.loc || ''))) countryCode = String(m.loc);
    if (m.ip) egressIp = String(m.ip);
    refreshNodeName();
    writeOutput();
    console.log('GEO_READY country=' + (countryCode || 'unknown') + ' egress_ip=' + (egressIp || 'unknown'));
    return true;
  } catch (e) {
    console.log('GEO_PENDING reason=' + String(e.message || e));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body) {
  if (!registryToken) throw new Error('registry token unavailable');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + registryToken,
        'x-registry-token': registryToken,
        'user-agent': 'container-test-rustix/1.0'
      },
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + (text ? ' ' + text.slice(0, 160) : ''));
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function registryPayload() {
  return {
    kind: 'proxy',
    node_id: identity.nodeId,
    name: nodeName,
    provider: 'rustix',
    protocol: 'vless',
    uri: nodeUri(),
    priority: 80,
    address: publicHost,
    port: publicPort,
    transport: 'ws',
    tls: publicTls,
    metadata: {
      location: countryCode || '',
      platform: 'Rustix.me',
      runtime: 'NodeJS 24',
      allocation: publicHost + ':' + publicPort
    }
  };
}

async function registerNode() {
  registryToken = readRegistryToken();
  if (!registryToken) {
    console.log('REGISTRY_DISABLED reason=token_missing');
    return false;
  }
  try {
    await postJson(registryBase + registerPath, registryPayload());
    console.log('REGISTRY_READY node_id=' + identity.nodeId + ' provider=rustix');
    return true;
  } catch (e) {
    console.log('REGISTRY_REGISTER_FAILED reason=' + String(e.message || e));
    return false;
  }
}

async function heartbeat() {
  registryToken = readRegistryToken();
  if (!registryToken) return;
  try {
    await postJson(registryBase + heartbeatPath, {
      node_id: identity.nodeId,
      status: 'online'
    });
    console.log('REGISTRY_HEARTBEAT_OK node_id=' + identity.nodeId);
  } catch (e) {
    console.log('REGISTRY_HEARTBEAT_RECOVER reason=' + String(e.message || e));
    await registerNode();
  }
}

function isPrivateIp(host) {
  if (net.isIP(host) === 4) {
    const p = host.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168);
  }
  if (net.isIP(host) === 6) {
    const h = host.toLowerCase();
    return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:');
  }
  return false;
}

function parseVlessRequest(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) throw new Error('short VLESS request');

  let i = 0;
  const version = buf[i++];
  const id = buf.subarray(i, i + 16);
  i += 16;

  if (id.length !== 16 || !crypto.timingSafeEqual(id, expectedUuid)) throw new Error('auth failed');

  const optLen = buf[i++];
  i += optLen;
  if (i + 4 > buf.length) throw new Error('invalid VLESS request');

  const command = buf[i++];
  if (command !== 1) throw new Error('only TCP CONNECT is supported');

  const port = buf.readUInt16BE(i);
  i += 2;
  const atyp = buf[i++];
  let host = '';

  if (atyp === 1) {
    if (i + 4 > buf.length) throw new Error('bad IPv4');
    host = Array.from(buf.subarray(i, i + 4)).join('.');
    i += 4;
  } else if (atyp === 2) {
    if (i >= buf.length) throw new Error('bad domain');
    const len = buf[i++];
    if (!len || i + len > buf.length) throw new Error('bad domain');
    host = buf.subarray(i, i + len).toString('utf8');
    i += len;
  } else if (atyp === 3) {
    if (i + 16 > buf.length) throw new Error('bad IPv6');
    const words = [];
    for (let n = 0; n < 8; n++) words.push(buf.readUInt16BE(i + n * 2).toString(16));
    host = words.join(':');
    i += 16;
  } else {
    throw new Error('unsupported address type');
  }

  if (!allowPrivateTargets && isPrivateIp(host)) throw new Error('private target blocked');
  return { version, host, port, payload: buf.subarray(i) };
}

function wsFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;

  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }

  return Buffer.concat([header, data]);
}

class WsPeer {
  constructor(socket, head, onBinary) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.onBinary = onBinary;
    this.closed = false;
    this.fragmentOpcode = null;
    this.fragments = [];

    socket.on('data', chunk => this.feed(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => {
      this.closed = true;
      if (this.onClose) this.onClose();
    });

    if (head && head.length) process.nextTick(() => this.feed(head));
  }

  feed(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      if (this.buffer.length < 2) return;

      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = !!(b0 & 0x80);
      const opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);

      if (!masked) return this.close(1002);

      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > 1048576n) return this.close(1009);
        len = Number(big);
        off = 10;
      }

      if (len > 1048576) return this.close(1009);
      if (this.buffer.length < off + 4 + len) return;

      const mask = this.buffer.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.from(this.buffer.subarray(off, off + len));
      this.buffer = this.buffer.subarray(off + len);

      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) {
        this.send(0xA, payload);
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode === 0x1) return this.close(1003);

      if (opcode === 0x2) {
        if (fin) this.onBinary(payload);
        else {
          this.fragmentOpcode = 2;
          this.fragments = [payload];
        }
        continue;
      }

      if (opcode === 0 && this.fragmentOpcode === 2) {
        this.fragments.push(payload);
        if (fin) {
          const msg = Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragmentOpcode = null;
          this.onBinary(msg);
        }
        continue;
      }

      return this.close(1002);
    }
  }

  send(opcode, payload) {
    if (!this.closed && !this.socket.destroyed) this.socket.write(wsFrame(opcode, payload));
  }

  binary(payload) {
    this.send(2, payload);
  }

  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    try {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code);
      this.socket.write(wsFrame(8, p));
    } catch {}
    try { this.socket.end(); } catch {}
    setTimeout(() => {
      try { this.socket.destroy(); } catch {}
    }, 250).unref();
  }
}

function subscriptionHeaders() {
  return {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    'pragma': 'no-cache',
    'x-content-type-options': 'nosniff',
    'profile-title': 'Rustix',
    'profile-update-interval': '24'
  };
}

function requestHandler(req, res) {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}

  if (pathname === '/') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store'
    });
    return res.end('rustix node ready\n');
  }

  if (pathname === '/health') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    return res.end(JSON.stringify({
      ok: true,
      service: 'rustix-native-node',
      runtime: process.version,
      listen_port: listenPort,
      public_host: publicHost,
      public_port: publicPort,
      transport: 'ws',
      tls: publicTls,
      node_id: identity.nodeId,
      country: countryCode || null,
      egress_ip: egressIp || null,
      registry_configured: !!readRegistryToken()
    }));
  }

  if (pathname === nodePath) {
    res.writeHead(200, subscriptionHeaders());
    return res.end(nodeUri() + '\n');
  }

  if (pathname === subPath) {
    res.writeHead(200, subscriptionHeaders());
    return res.end(nodeUri() + '\n');
  }

  if (pathname === sub64Path) {
    res.writeHead(200, subscriptionHeaders());
    return res.end(Buffer.from(nodeUri() + '\n', 'utf8').toString('base64') + '\n');
  }

  res.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end('Not Found\n');
}

const server = http.createServer(requestHandler);
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}

  const key = req.headers['sec-websocket-key'];
  if (
    pathname !== identity.wsPath ||
    !key ||
    String(req.headers.upgrade || '').toLowerCase() !== 'websocket'
  ) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }

  const accept = crypto
    .createHash('sha1')
    .update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  let remote = null;
  let established = false;

  const peer = new WsPeer(socket, head, data => {
    if (established) {
      if (remote && !remote.destroyed) remote.write(data);
      return;
    }

    let info;
    try {
      info = parseVlessRequest(data);
    } catch (e) {
      console.log('VLESS_REJECT reason=' + String(e.message || e));
      return peer.close(1008);
    }

    remote = net.connect({ host: info.host, port: info.port });

    const fail = () => {
      try { if (remote) remote.destroy(); } catch {}
      peer.close(1011);
    };

    remote.setTimeout(60000, fail);
    remote.once('connect', () => {
      established = true;
      remote.setTimeout(0);
      peer.binary(Buffer.from([info.version, 0]));
      if (info.payload.length) remote.write(info.payload);
    });

    remote.on('data', chunk => peer.binary(chunk));
    remote.on('end', () => peer.close());
    remote.on('error', fail);
  });

  peer.onClose = () => {
    try { if (remote) remote.destroy(); } catch {}
  };
});

async function onListen() {
  refreshNodeName();
  writeOutput();

  console.log('SERVICE_READY HTTP/WS ' + listenHost + ':' + listenPort);
  console.log('NATIVE_READY ' + publicHost + ':' + publicPort + ' tls=' + (publicTls ? 'on' : 'off'));
  console.log('NODE_ID ' + identity.nodeId);
  console.log('VLESS_LINK ' + nodeUri());
  console.log('SUB_URL ' + publicBase() + subPath);
  console.log('SUB64_URL ' + publicBase() + sub64Path);

  await detectGeo();
  console.log('VLESS_LINK_FINAL ' + nodeUri());

  await registerNode();

  setInterval(async () => {
    if (!countryCode) await detectGeo();
    await heartbeat();
  }, heartbeatMinutes * 60000).unref();
}

server.listen(listenPort, listenHost, () => {
  onListen().catch(e => console.log('STARTUP_ASYNC_FAILED reason=' + String(e.message || e)));
});

function shutdown(signal) {
  console.log('SHUTDOWN ' + signal);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
