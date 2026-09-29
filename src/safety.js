// Guards against writing to the wrong database.
// A remote (non-local) Supabase project is refused unless its exact hostname is
// explicitly confirmed (ANALYZE_CONFIRM_REMOTE_DB=<hostname> or the confirm argument).

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal', 'kong', 'supabase_kong']);

export function isLocalHost(hostname) {
  const h = String(hostname).toLowerCase();
  return LOCAL_HOSTS.has(h) || h.endsWith('.localhost');
}

export function assertSafeTarget(url, confirmHost) {
  let u;
  try { u = new URL(url); } catch { throw new Error('SUPABASE_URL is not a valid URL'); }
  if (isLocalHost(u.hostname)) return { local: true, host: u.hostname };
  if (confirmHost && confirmHost.toLowerCase() === u.hostname.toLowerCase()) return { local: false, host: u.hostname, confirmed: true };
  throw new Error(
    `Refusing to write to non-local database "${u.hostname}". ` +
    `Point SUPABASE_URL at a local/test instance, or explicitly confirm this exact host by setting ` +
    `ANALYZE_CONFIRM_REMOTE_DB=${u.hostname}`,
  );
}
