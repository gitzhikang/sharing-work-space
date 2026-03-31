const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

export const DEFAULT_PEERJS_SERVER_URL = 'https://0.peerjs.com/';
export const CUSTOM_PEERJS_STORAGE_KEY = 'conclave-custom-peerjs-server-url';
export const PEERJS_CONNECTION_TIMEOUT_MS = 10000;

function createSharedPeerOptions() {
  return {
    debug: 3,
    config: {
      iceServers: DEFAULT_ICE_SERVERS.map(server => Object.assign({}, server))
    }
  };
}

export const PEERJS_PUBLIC_SERVER = {
  host: '0.peerjs.com',
  port: 443,
  path: '/',
  secure: true,
  ...createSharedPeerOptions()
};

export function buildPeerServerConfig(serverUrl) {
  const normalizedUrl = typeof serverUrl === 'string' ? serverUrl.trim() : '';

  if (!normalizedUrl) {
    throw new Error('请输入完整的 PeerJS 服务器地址。');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch (err) {
    throw new Error('地址格式不正确，请输入完整 URL，例如 https://your-peer-server.com/ 或 http://localhost:9000/。');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('PeerJS 服务器地址必须以 http:// 或 https:// 开头。');
  }

  return {
    host: parsedUrl.hostname,
    port: parsedUrl.port ? parseInt(parsedUrl.port, 10) : (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: normalizePeerPath(parsedUrl.pathname),
    secure: parsedUrl.protocol === 'https:',
    ...createSharedPeerOptions()
  };
}

export function getStoredCustomPeerServerUrl(win = window) {
  try {
    if (!win || !win.localStorage) return '';
    return win.localStorage.getItem(CUSTOM_PEERJS_STORAGE_KEY) || '';
  } catch (err) {
    return '';
  }
}

export function storeCustomPeerServerUrl(serverUrl, win = window) {
  try {
    if (win && win.localStorage && serverUrl) {
      win.localStorage.setItem(CUSTOM_PEERJS_STORAGE_KEY, serverUrl);
    }
  } catch (err) {
    return;
  }
}

function normalizePeerPath(pathname = '/') {
  const normalizedPath = pathname && pathname.trim() ? pathname.trim() : '/';
  return normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
}

export default PEERJS_PUBLIC_SERVER;
