import assert from 'node:assert/strict';

const endpoint = process.argv[2] ?? 'http://127.0.0.1:6006/mcp';
let session;
let protocol = '2025-11-25';
let requestId = 0;

async function request(method, params, notification = false) {
  const id = notification ? undefined : ++requestId;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': protocol,
      ...(session ? { 'Mcp-Session-Id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${await response.text()}`);
  session = response.headers.get('mcp-session-id') ?? session;
  if (notification) {
    await response.body?.cancel();
    return;
  }
  let message;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!message) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const candidate = JSON.parse(data);
          if (candidate.id === id) message = candidate;
        }
      }
    } finally {
      await reader.cancel();
    }
  } else {
    message = await response.json();
  }
  assert(message, `${method}: нет JSON-RPC ответа`);
  assert(!message.error, `${method}: ${JSON.stringify(message.error)}`);
  assert(!message.result?.isError, `${method}: ${JSON.stringify(message.result)}`);
  return message.result;
}

try {
  const initialized = await request('initialize', {
    protocolVersion: protocol,
    capabilities: {},
    clientInfo: { name: 'choral-agent-verification', version: '1.0.0' },
  });
  protocol = initialized.protocolVersion;
  console.log(`MCP: ${initialized.serverInfo.name} ${initialized.serverInfo.version}; протокол ${protocol}`);
  await request('notifications/initialized', {}, true);
  const { tools } = await request('tools/list', {});
  assert(tools.some((tool) => tool.name === 'docs-list'), 'docs-list недоступен');
  assert(tools.some((tool) => tool.name === 'docs-show'), 'docs-show недоступен');
  console.log(`Инструменты: ${tools.map((tool) => tool.name).join(', ')}`);
  const index = await request('tools/call', { name: 'docs-list', arguments: {} });
  const indexText = JSON.stringify(index);
  for (const id of ['components-track-controls', 'layouts-rehearsal-player']) {
    assert(indexText.includes(id), `${id} отсутствует в ответе docs-list`);
  }
  const component = await request('tools/call', {
    name: 'docs-show', arguments: { id: 'components-track-controls' },
  });
  const documentation = JSON.stringify(component);
  for (const prop of ['volume', 'muted', 'solo', 'onSoloChange']) {
    assert(documentation.includes(prop), `API TrackControls не содержит ${prop}`);
  }
  console.log('docs-list: найден TrackControls и макет плеера.');
  console.log('docs-show: получены свойства TrackControls и примеры stories.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
