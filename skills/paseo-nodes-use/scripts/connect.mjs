// Shared by the node.sh SDK helpers. node.sh has already resolved the node and
// checked its serverId; this rebuilds the daemon connection from its environment.
export function connectionConfig() {
  const expected = process.env.PASEO_NODE_EXPECTED_ID;
  if (!expected) throw new Error('Use paseo-nodes-use/scripts/node.sh');
  const config = { connectTimeoutMs: 15000, reconnect: { enabled: false }, appVersion: '0.12.0' };
  if (process.env.PASEO_NODE_OFFER) {
    const hash = new URL(process.env.PASEO_NODE_OFFER).hash.slice(1).replace(/^offer=/, '');
    const offer = JSON.parse(Buffer.from(decodeURIComponent(hash), 'base64url').toString());
    if (offer.serverId !== expected) throw new Error('Node identity mismatch');
    const tls = offer.relay.useTls ?? offer.relay.endpoint.endsWith(':443');
    const url = new URL(`${tls ? 'wss' : 'ws'}://${offer.relay.endpoint}/ws`);
    url.searchParams.set('serverId', expected);
    url.searchParams.set('role', 'client');
    url.searchParams.set('v', '2');
    config.url = url.toString();
    config.e2ee = { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 };
    if (process.env.PASEO_PASSWORD) config.password = process.env.PASEO_PASSWORD;
  } else {
    const endpoint = process.env.PASEO_NODE_ENDPOINT;
    if (!endpoint || endpoint.startsWith('/')) throw new Error('SDK access requires a TCP daemon endpoint');
    config.url = /^wss?:/.test(endpoint) ? endpoint : `ws://${endpoint}/ws`;
    config.password = process.env.PASEO_PASSWORD;
  }
  delete process.env.PASEO_NODE_OFFER;
  return config;
}
