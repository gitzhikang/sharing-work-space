import Peer from 'peerjs';
import SimpleMDE from 'simplemde';

import Controller from './controller';
import Broadcast from './broadcast';
import Editor from './editor';
import peerConfig, {
  PEERJS_CONNECTION_TIMEOUT_MS,
  buildPeerServerConfig,
  getStoredCustomPeerServerUrl,
  storeCustomPeerServerUrl,
} from './peerConfig';

const DEFAULT_CUSTOM_PEER_SERVER_URL = 'http://localhost:9000/';

function buildEditor() {
  return new Editor(new SimpleMDE({
    placeholder: "Share the link to invite collaborators to your document.",
    spellChecker: false,
    toolbar: false,
    autofocus: false,
    indentWithTabs: true,
    tabSize: 4,
    indentUnit: 4,
    lineWrapping: false,
    shortCuts: []
  }));
}

function createPeerConnection(config, win = window) {
  return new Promise((resolve, reject) => {
    const peer = new Peer(config);
    let settled = false;
    const timeoutId = win.setTimeout(() => {
      if (settled) return;
      settled = true;
      const timeoutError = new Error(`Timed out after ${PEERJS_CONNECTION_TIMEOUT_MS / 1000} seconds`);
      timeoutError.type = 'server-timeout';
      safelyDestroyPeer(peer);
      reject(timeoutError);
    }, PEERJS_CONNECTION_TIMEOUT_MS);

    peer.on('open', () => {
      if (settled) return;
      settled = true;
      win.clearTimeout(timeoutId);
      resolve(peer);
    });

    peer.on('error', err => {
      if (settled) return;
      settled = true;
      win.clearTimeout(timeoutId);
      safelyDestroyPeer(peer);
      reject(err);
    });
  });
}

function connectWithPeerServerFallback(win = window) {
  return createPeerConnection(peerConfig, win)
    .catch(err => retryWithCustomPeerServer(err, win));
}

function retryWithCustomPeerServer(lastError, win = window) {
  const customServer = promptForCustomPeerServer(lastError, win);
  if (!customServer) {
    const cancelledError = new Error('PeerJS server prompt cancelled');
    cancelledError.code = 'peer-server-prompt-cancelled';
    throw cancelledError;
  }

  return createPeerConnection(customServer.config, win)
    .catch(err => {
      win.alert(`无法连接到自定义 PeerJS 服务器：${describePeerServerError(err)}。请检查地址后重试。`);
      return retryWithCustomPeerServer(err, win);
    });
}

function promptForCustomPeerServer(lastError, win = window) {
  while (true) {
    const savedServerUrl = getStoredCustomPeerServerUrl(win) || DEFAULT_CUSTOM_PEER_SERVER_URL;
    const message = [
      `无法连接 PeerJS 官方服务器：${describePeerServerError(lastError)}`,
      '请输入你自己的 PeerJS 服务器地址。',
      '示例：https://your-peer-server.com/ 或 http://localhost:9000/'
    ].join('\n');
    const serverUrl = win.prompt(message, savedServerUrl);

    if (serverUrl === null) {
      return null;
    }

    try {
      const config = buildPeerServerConfig(serverUrl);
      storeCustomPeerServerUrl(serverUrl.trim(), win);
      return { config, serverUrl: serverUrl.trim() };
    } catch (err) {
      win.alert(err.message);
    }
  }
}

function describePeerServerError(err) {
  if (!err) return '未知错误';
  if (err.type === 'server-timeout') {
    return `连接超时（${PEERJS_CONNECTION_TIMEOUT_MS / 1000} 秒）`;
  }

  return err.type || err.message || String(err);
}

function safelyDestroyPeer(peer) {
  if (!peer || typeof peer.destroy !== 'function') return;

  try {
    peer.destroy();
  } catch (err) {
    console.warn('[main] Failed to destroy peer after connection error:', err);
  }
}

function showPeerServerSetupRequired(doc = document) {
  const loading = doc.querySelector('.loading');
  if (!loading) return;

  const paragraphs = loading.querySelectorAll('p');
  if (paragraphs[0]) {
    paragraphs[0].textContent = '需要配置 PeerJS 服务器';
  }
  if (paragraphs[1]) {
    paragraphs[1].textContent = '请刷新页面后输入一个可访问的自定义 PeerJS 服务器地址。';
  }
  if (paragraphs[2]) {
    paragraphs[2].textContent = '连接到可用的 PeerJS 服务器后，应用会继续初始化。';
  }
}

if (/^((?!chrome|android).)*safari/i.test(navigator.userAgent)) {

} else {
  connectWithPeerServerFallback(window)
    .then(peer => {
      new Controller(
        (location.search.slice(1) || '0'),
        location.origin,
        peer,
        new Broadcast(),
        buildEditor()
      );
    })
    .catch(err => {
      if (err && err.code === 'peer-server-prompt-cancelled') {
        showPeerServerSetupRequired(document);
        return;
      }

      console.error('[main] Failed to initialize PeerJS:', err);
      window.alert(`无法初始化 PeerJS：${describePeerServerError(err)}`);
      showPeerServerSetupRequired(document);
    });
}
