'use strict';
/*
 * Who is allowed to reach this server.
 *
 * The default is unchanged and unchanged on purpose: loopback only, where "can open a
 * socket to 127.0.0.1" already means "is a program running as you", so the per-run token
 * is enough and the page can simply carry it.
 *
 * That reasoning breaks the moment the server is reachable from another machine. The page
 * hands out the token to anyone who can GET it, so exposure without authentication is
 * exposure with none. A tailnet is NOT an authentication boundary either — a tailnet can
 * have other people's laptops on it, and this app runs git and gh as you.
 *
 * So remote access is defined narrowly:
 *
 *   - Only through `tailscale serve`, which terminates TLS and proxies to loopback. The
 *     bind address never changes; nothing new listens on a public interface.
 *   - tailscaled attaches the authenticated tailnet user as Tailscale-User-Login, and
 *     strips any such header a client tried to send. We require it.
 *   - That header is only believed when the TCP peer is loopback, i.e. when the request
 *     really did come from the local proxy rather than from a remote client asserting it.
 *   - The login must be on an allowlist, so "on the tailnet" is not the same as "allowed".
 *
 * Funnel — Tailscale's public-internet mode — carries no identity, so those requests fail
 * the same check. That is the real protection; the startup check is only a courtesy.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/* Host headers arrive with ports, casing, IPv6 brackets, and sometimes a FQDN's trailing dot. */
function normalizeHost(raw) {
  let value = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end > -1) return value.slice(1, end);        // [::1]:11001 → ::1
  }
  value = value.replace(/:\d+$/, '');
  return value.replace(/\.$/, '');
}

function isLoopbackAddress(addr) {
  const value = String(addr == null ? '' : addr).trim().toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1' ||
    value.startsWith('127.');
}

const normalizeUser = (raw) => String(raw == null ? '' : raw).trim().toLowerCase();

class AccessError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'AccessError';
    this.status = 403;
    this.detail = detail || null;                    // logged locally, never sent to the client
  }
}

/*
 * `hosts` are the extra Host values served (the node's MagicDNS name). `users` are the
 * tailnet logins allowed through them; an empty list means nobody, because an allowlist
 * that defaults to "everyone" on a shared tailnet is worse than no remote access at all.
 */
function createAccess({ port, hosts = [], users = [] } = {}) {
  const remoteHosts = new Set(hosts.map(normalizeHost).filter(Boolean));
  const allowedUsers = new Set(users.map(normalizeUser).filter(Boolean));
  const localOrigins = new Set([
    'http://127.0.0.1:' + port,
    'http://localhost:' + port,
  ]);
  // Serve always fronts with HTTPS on 443, so the browser sends a portless https origin.
  const remoteOrigins = new Set();
  for (const host of remoteHosts) {
    remoteOrigins.add('https://' + host);
    remoteOrigins.add('https://' + host + ':443');
  }

  function check(req) {
    const host = normalizeHost(req.headers && req.headers.host);
    const peerLocal = isLoopbackAddress(req.socket && req.socket.remoteAddress);

    if (LOOPBACK_HOSTS.has(host)) {
      // Reaching us as "localhost" from another machine means the bind address is wrong.
      if (!peerLocal) throw new AccessError('Only loopback hosts are served');
      return finish(req, { scope: 'local', user: null }, localOrigins);
    }

    if (!remoteHosts.has(host)) {
      throw new AccessError('Only loopback hosts are served',
        host ? `refused Host "${host}"` : 'refused a request with no Host header');
    }

    // A remote peer means something is listening off-loopback — never this server's doing.
    if (!peerLocal) {
      throw new AccessError('Reach this through tailscale serve, not directly',
        'a non-loopback peer used the tailnet host name');
    }

    const login = normalizeUser(req.headers['tailscale-user-login']);
    if (!login) {
      throw new AccessError('Tailscale identity is required for remote access',
        'no Tailscale-User-Login header — the request did not come through `tailscale serve`, ' +
        'or it came over Funnel, which carries no identity');
    }
    if (!allowedUsers.has(login)) {
      throw new AccessError('That Tailscale account is not allowed to use this server',
        `refused tailnet login ${login}`);
    }
    return finish(req, { scope: 'tailnet', user: login }, remoteOrigins);
  }

  /* Origin is the cross-site defense and is checked for every scope, not just remote. */
  function finish(req, result, origins) {
    const origin = req.headers && req.headers.origin;
    if (origin && !origins.has(String(origin).toLowerCase())) {
      throw new AccessError('Cross-origin requests are refused', `refused Origin "${origin}"`);
    }
    return result;
  }

  return {
    check,
    remote: remoteHosts.size > 0,
    hosts: [...remoteHosts],
    users: [...allowedUsers],
  };
}

module.exports = { createAccess, normalizeHost, normalizeUser, isLoopbackAddress, AccessError };
