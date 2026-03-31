import Peer from 'peerjs';

import CRDT from './crdt';
import VersionVector from './versionVector';
import Identifier from './identifier';
import Char from './char';

function parseInteger(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatMs(value) {
  return `${value.toFixed(3)} ms`;
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;

  const scaledIndex = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(scaledIndex);
  const upper = Math.ceil(scaledIndex);

  if (lower === upper) {
    return sortedValues[lower];
  }

  const weight = scaledIndex - lower;
  return sortedValues[lower] + ((sortedValues[upper] - sortedValues[lower]) * weight);
}

function buildStats(values) {
  if (!values || values.length === 0) {
    return null;
  }

  const sorted = values.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);

  return {
    count: sorted.length,
    mean: sum / sorted.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1]
  };
}

function renderStats(stats) {
  if (!stats) {
    return '<p>No samples collected.</p>';
  }

  return `
    <div class="benchmark-metric-grid">
      <div class="benchmark-metric"><span class="metric-label">Samples</span><span class="metric-value">${stats.count}</span></div>
      <div class="benchmark-metric"><span class="metric-label">Mean</span><span class="metric-value">${formatMs(stats.mean)}</span></div>
      <div class="benchmark-metric"><span class="metric-label">Median</span><span class="metric-value">${formatMs(stats.median)}</span></div>
      <div class="benchmark-metric"><span class="metric-label">P95</span><span class="metric-value">${formatMs(stats.p95)}</span></div>
      <div class="benchmark-metric"><span class="metric-label">Min</span><span class="metric-value">${formatMs(stats.min)}</span></div>
      <div class="benchmark-metric"><span class="metric-label">Max</span><span class="metric-value">${formatMs(stats.max)}</span></div>
    </div>
  `;
}

function localPeerConfig() {
  return {
    host: window.location.hostname,
    port: parseInteger(window.location.port, window.location.protocol === 'https:' ? 443 : 80),
    path: '/peerjs',
    secure: window.location.protocol === 'https:',
    debug: 1,
    config: {
      iceServers: []
    }
  };
}

function createPayload(byteCount) {
  if (byteCount <= 0) return '';
  return 'x'.repeat(byteCount);
}

function getQueryParams() {
  return new URLSearchParams(window.location.search);
}

function waitForPeerOpen(peer) {
  return new Promise((resolve, reject) => {
    peer.on('open', id => resolve(id));
    peer.on('error', reject);
  });
}

function waitForConnectionOpen(connection) {
  return new Promise((resolve, reject) => {
    connection.on('open', () => resolve(connection));
    connection.on('error', reject);
  });
}

class LatencyReplica {
  constructor(siteId, onControlMessage) {
    this.siteId = siteId;
    this.onControlMessage = onControlMessage;
    this.connection = null;
    this.resetState();
  }

  setConnection(connection) {
    this.connection = connection;
    connection.on('data', data => {
      this.handleIncomingData(data);
    });
  }

  resetState() {
    this.vector = new VersionVector(this.siteId);
    this.crdt = new CRDT(this);
    this.buffer = [];
    this.line = 0;
    this.ch = 0;
    this.pendingBenchmarkMeta = null;
  }

  handleIncomingData(data) {
    let message = data;

    if (typeof data === 'string') {
      message = JSON.parse(data);
    }

    if (!message) return;

    if (message.kind === 'latency-ping') {
      this.sendPayload({
        kind: 'latency-pong',
        id: message.id,
        sentAt: message.sentAt,
        receivedAt: performance.now()
      });
      return;
    }

    if (message.kind === 'latency-pong' || message.kind === 'latency-ack') {
      if (this.onControlMessage) {
        this.onControlMessage(message);
      }
      return;
    }

    if (message.type === 'insert' || message.type === 'delete') {
      this.handleRemoteOperation(message);
    }
  }

  sendPayload(payload) {
    if (!this.connection || this.connection.open === false) {
      throw new Error('Peer connection is not open yet.');
    }

    this.connection.send(JSON.stringify(payload));
  }

  insertMeasuredCharacter(benchmarkMeta) {
    this.pendingBenchmarkMeta = benchmarkMeta;
    const position = { line: this.line, ch: this.ch };
    const start = performance.now();
    this.crdt.handleLocalInsert('a', position);
    const end = performance.now();
    this.ch += 1;
    return end - start;
  }

  deleteMeasuredCharacter(benchmarkMeta) {
    if (this.ch <= 0) {
      throw new Error('No local character is available for deletion.');
    }

    this.pendingBenchmarkMeta = benchmarkMeta;
    const startPos = { line: this.line, ch: this.ch - 1 };
    const endPos = { line: this.line, ch: this.ch };
    const start = performance.now();
    this.crdt.handleLocalDelete(startPos, endPos);
    const end = performance.now();
    this.ch -= 1;
    return end - start;
  }

  processDeletionBuffer() {
    let index = 0;

    while (index < this.buffer.length) {
      const operation = this.buffer[index];

      if (this.hasInsertionBeenApplied(operation)) {
        this.applyOperation(operation);
        this.buffer.splice(index, 1);
      } else {
        index += 1;
      }
    }
  }

  hasInsertionBeenApplied(operation) {
    const charVersion = { siteId: operation.char.siteId, counter: operation.char.counter };
    return this.vector.hasBeenApplied(charVersion);
  }

  handleRemoteOperation(operation) {
    const receivedAt = performance.now();

    if (this.vector.hasBeenApplied(operation.version)) {
      return;
    }

    if (operation.type === 'insert') {
      this.applyOperation(operation);
    } else if (operation.type === 'delete') {
      this.buffer.push(operation);
    }

    this.processDeletionBuffer();

    const appliedAt = performance.now();

    if (operation.benchmark) {
      this.sendPayload({
        kind: 'latency-ack',
        id: operation.benchmark.id,
        sentAt: operation.benchmark.sentAt,
        receivedAt: receivedAt,
        appliedAt: appliedAt
      });
    }
  }

  applyOperation(operation) {
    const char = operation.char;
    const identifiers = char.position.map(pos => new Identifier(pos.digit, pos.siteId));
    const newChar = new Char(char.value, char.counter, char.siteId, identifiers);

    if (operation.type === 'insert') {
      this.crdt.handleRemoteInsert(newChar);
    } else if (operation.type === 'delete') {
      this.crdt.handleRemoteDelete(newChar, operation.version.siteId);
    }

    this.vector.update(operation.version);
  }

  broadcastInsertion(char) {
    const operation = {
      type: 'insert',
      char: char,
      version: this.vector.getLocalVersion()
    };

    if (this.pendingBenchmarkMeta) {
      operation.benchmark = this.pendingBenchmarkMeta;
      this.pendingBenchmarkMeta = null;
    }

    this.sendPayload(operation);
  }

  broadcastDeletion(char, version) {
    const operation = {
      type: 'delete',
      char: char,
      version: version || this.vector.getLocalVersion()
    };

    if (this.pendingBenchmarkMeta) {
      operation.benchmark = this.pendingBenchmarkMeta;
      this.pendingBenchmarkMeta = null;
    }

    this.sendPayload(operation);
  }

  insertIntoEditor() {}

  deleteFromEditor() {}
}

class BenchmarkApp {
  constructor(doc = document) {
    this.doc = doc;
    this.isRunning = false;
    this.pendingPings = {};
    this.pendingOperations = {};
    this.sequence = 0;
    this.rawResults = [];
    this.operationResults = [];
    this.peerA = null;
    this.peerB = null;
    this.connectionA = null;
    this.connectionB = null;
    this.senderReplica = new LatencyReplica('latency-peer-a', this.handleControlMessage.bind(this));
    this.receiverReplica = new LatencyReplica('latency-peer-b', this.handleControlMessage.bind(this));
    this.cacheDom();
    this.bindEvents();
    this.renderButtonState();
  }

  cacheDom() {
    this.initializePeersBtn = this.doc.querySelector('#initializePeersBtn');
    this.runRawBtn = this.doc.querySelector('#runRawBtn');
    this.runOperationBtn = this.doc.querySelector('#runOperationBtn');
    this.runFourOpsBtn = this.doc.querySelector('#runFourOpsBtn');
    this.resetStateBtn = this.doc.querySelector('#resetStateBtn');
    this.sampleCountInput = this.doc.querySelector('#sampleCountInput');
    this.warmupCountInput = this.doc.querySelector('#warmupCountInput');
    this.payloadBytesInput = this.doc.querySelector('#payloadBytesInput');
    this.benchmarkStatus = this.doc.querySelector('#benchmarkStatus');
    this.peerAId = this.doc.querySelector('#peerAId');
    this.peerBId = this.doc.querySelector('#peerBId');
    this.channelOpenTime = this.doc.querySelector('#channelOpenTime');
    this.rawSummary = this.doc.querySelector('#rawSummary');
    this.operationSummary = this.doc.querySelector('#operationSummary');
    this.rawResultsBody = this.doc.querySelector('#rawResultsBody');
    this.operationResultsBody = this.doc.querySelector('#operationResultsBody');
    this.operationHeader1 = this.doc.querySelector('#operationHeader1');
    this.operationHeader2 = this.doc.querySelector('#operationHeader2');
    this.operationHeader3 = this.doc.querySelector('#operationHeader3');
    this.operationHeader4 = this.doc.querySelector('#operationHeader4');
    this.logElement = this.doc.querySelector('#benchmarkLog');
    this.benchmarkJson = this.doc.querySelector('#benchmarkJson');
  }

  bindEvents() {
    this.initializePeersBtn.addEventListener('click', () => {
      this.initializePeers().catch(err => this.handleError(err));
    });

    this.runRawBtn.addEventListener('click', () => {
      this.runRawBenchmark().catch(err => this.handleError(err));
    });

    this.runOperationBtn.addEventListener('click', () => {
      this.runOperationBenchmark().catch(err => this.handleError(err));
    });

    this.runFourOpsBtn.addEventListener('click', () => {
      this.runFourOperationBenchmark().catch(err => this.handleError(err));
    });

    this.resetStateBtn.addEventListener('click', () => {
      this.resetReplicas();
    });

    window.addEventListener('beforeunload', () => {
      this.teardown();
    });
  }

  setStatus(message) {
    this.benchmarkStatus.textContent = message;
  }

  appendLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    const current = this.logElement.textContent ? `${this.logElement.textContent}\n` : '';
    this.logElement.textContent = `${current}[${timestamp}] ${message}`;
    this.logElement.scrollTop = this.logElement.scrollHeight;
  }

  renderButtonState() {
    const connected = !!(this.connectionA && this.connectionB && this.connectionA.open && this.connectionB.open);

    this.initializePeersBtn.disabled = this.isRunning;
    this.runRawBtn.disabled = this.isRunning || !connected;
    this.runOperationBtn.disabled = this.isRunning || !connected;
    this.runFourOpsBtn.disabled = this.isRunning || !connected;
    this.resetStateBtn.disabled = this.isRunning || !connected;
  }

  nextId(prefix) {
    this.sequence += 1;
    return `${prefix}-${Date.now()}-${this.sequence}`;
  }

  getBenchmarkOptions() {
    const samples = Math.max(1, parseInteger(this.sampleCountInput.value, 50));
    const warmup = Math.max(0, parseInteger(this.warmupCountInput.value, 5));
    const payloadBytes = Math.max(0, parseInteger(this.payloadBytesInput.value, 64));

    return {
      samples: samples,
      warmup: warmup,
      payloadBytes: payloadBytes
    };
  }

  async initializePeers() {
    this.isRunning = true;
    this.renderButtonState();
    this.setStatus('Initializing local peers...');
    this.appendLog('Creating two local PeerJS peers on this machine.');
    await this.teardown();

    const config = localPeerConfig();
    const incomingConnectionPromise = new Promise(resolve => {
      const peer = new Peer(undefined, config);
      this.peerB = peer;
      peer.on('connection', connection => resolve(connection));
      peer.on('error', err => this.handleError(err));
    });

    this.peerA = new Peer(undefined, config);
    this.peerA.on('error', err => this.handleError(err));

    const [peerAId, peerBId] = await Promise.all([
      waitForPeerOpen(this.peerA),
      waitForPeerOpen(this.peerB)
    ]);

    this.peerAId.textContent = peerAId;
    this.peerBId.textContent = peerBId;
    this.appendLog(`Peer A opened as ${peerAId}.`);
    this.appendLog(`Peer B opened as ${peerBId}.`);

    const channelStart = performance.now();
    const outgoingConnection = this.peerA.connect(peerBId, { reliable: true });
    const incomingConnection = await incomingConnectionPromise;

    await Promise.all([
      waitForConnectionOpen(outgoingConnection),
      waitForConnectionOpen(incomingConnection)
    ]);

    this.connectionA = outgoingConnection;
    this.connectionB = incomingConnection;
    this.senderReplica.setConnection(this.connectionA);
    this.receiverReplica.setConnection(this.connectionB);
    this.channelOpenTime.textContent = formatMs(performance.now() - channelStart);

    this.resetReplicas();
    this.setStatus('Ready');
    this.appendLog('Local data channel is open. Benchmarks are ready to run.');
    this.isRunning = false;
    this.renderButtonState();
  }

  resetReplicas() {
    this.senderReplica.resetState();
    this.receiverReplica.resetState();
    this.appendLog('Benchmark replica state reset to an empty document on both peers.');
  }

  handleControlMessage(message) {
    if (message.kind === 'latency-pong') {
      const pendingPing = this.pendingPings[message.id];
      if (!pendingPing) return;

      delete this.pendingPings[message.id];
      window.clearTimeout(pendingPing.timeoutId);

      const now = performance.now();
      pendingPing.resolve({
        oneWay: message.receivedAt - message.sentAt,
        rtt: now - message.sentAt,
        returnPath: now - message.receivedAt
      });
      return;
    }

    if (message.kind === 'latency-ack') {
      const pendingOperation = this.pendingOperations[message.id];
      if (!pendingOperation) return;

      delete this.pendingOperations[message.id];
      window.clearTimeout(pendingOperation.timeoutId);

      const now = performance.now();
      pendingOperation.resolve({
        operationType: pendingOperation.operationType,
        localDuration: pendingOperation.localDuration,
        transport: message.receivedAt - message.sentAt,
        remoteProcessing: message.appliedAt - message.receivedAt,
        applyComplete: message.appliedAt - message.sentAt,
        ackRtt: now - message.sentAt
      });
    }
  }

  ensureReady() {
    if (!this.connectionA || !this.connectionB || !this.connectionA.open || !this.connectionB.open) {
      throw new Error('Initialize the local peers before running a benchmark.');
    }
  }

  runSinglePing(payloadBytes) {
    return new Promise((resolve, reject) => {
      const id = this.nextId('ping');
      const timeoutId = window.setTimeout(() => {
        delete this.pendingPings[id];
        reject(new Error('Timed out while waiting for a pong response.'));
      }, 5000);

      this.pendingPings[id] = { resolve: resolve, timeoutId: timeoutId };
      this.senderReplica.sendPayload({
        kind: 'latency-ping',
        id: id,
        sentAt: performance.now(),
        payload: createPayload(payloadBytes)
      });
    });
  }

  runSingleOperation(operationType = 'insert') {
    return new Promise((resolve, reject) => {
      const id = this.nextId(operationType);
      const timeoutId = window.setTimeout(() => {
        delete this.pendingOperations[id];
        reject(new Error('Timed out while waiting for the remote apply acknowledgement.'));
      }, 5000);

      this.pendingOperations[id] = {
        resolve: resolve,
        timeoutId: timeoutId,
        operationType: operationType,
        localDuration: 0
      };

      const benchmarkMeta = {
        id: id,
        sentAt: performance.now()
      };

      let localDuration;

      if (operationType === 'delete') {
        localDuration = this.senderReplica.deleteMeasuredCharacter(benchmarkMeta);
      } else {
        localDuration = this.senderReplica.insertMeasuredCharacter(benchmarkMeta);
      }

      this.pendingOperations[id].localDuration = localDuration;
    });
  }

  async runRawBenchmark() {
    this.ensureReady();
    this.isRunning = true;
    this.renderButtonState();

    const options = this.getBenchmarkOptions();
    const totalSamples = options.samples + options.warmup;
    const measuredResults = [];

    this.setStatus('Running raw ping benchmark...');
    this.appendLog(`Running raw ping benchmark with ${options.samples} measured samples, ${options.warmup} warmups, and ${options.payloadBytes} payload bytes.`);

    for (let index = 0; index < totalSamples; index++) {
      const result = await this.runSinglePing(options.payloadBytes);
      if (index >= options.warmup) {
        measuredResults.push(result);
      }
    }

    this.rawResults = measuredResults;
    this.renderRawResults();
    this.setStatus('Ready');
    this.appendLog('Raw ping benchmark completed.');
    this.isRunning = false;
    this.renderButtonState();
  }

  async runOperationBenchmark() {
    this.ensureReady();
    this.isRunning = true;
    this.renderButtonState();
    this.resetReplicas();

    const options = this.getBenchmarkOptions();
    const totalSamples = options.samples + options.warmup;
    const measuredResults = [];

    this.setStatus('Running insert latency benchmark...');
    this.appendLog(`Running insert-operation benchmark with ${options.samples} measured samples and ${options.warmup} warmups.`);

    for (let index = 0; index < totalSamples; index++) {
      const result = await this.runSingleOperation('insert');
      if (index >= options.warmup) {
        measuredResults.push(result);
      }
    }

    this.operationResults = measuredResults;
    this.renderOperationResults();
    this.setStatus('Ready');
    this.appendLog('Insert-operation benchmark completed.');
    this.isRunning = false;
    this.renderButtonState();
  }

  async runFourOperationBenchmark() {
    this.ensureReady();
    this.isRunning = true;
    this.renderButtonState();
    this.resetReplicas();

    const options = this.getBenchmarkOptions();
    const totalSamples = options.samples + options.warmup;
    const localInsertions = [];
    const remoteInsertions = [];
    const localDeletions = [];
    const remoteDeletions = [];

    this.setStatus('Running 4-operation benchmark...');
    this.appendLog(`Running 4-operation benchmark with ${options.samples} measured samples and ${options.warmup} warmups.`);

    for (let index = 0; index < totalSamples; index++) {
      const result = await this.runSingleOperation('insert');
      if (index >= options.warmup) {
        localInsertions.push(result.localDuration);
        remoteInsertions.push(result.applyComplete);
      }
    }

    for (let index = 0; index < totalSamples; index++) {
      const result = await this.runSingleOperation('delete');
      if (index >= options.warmup) {
        localDeletions.push(result.localDuration);
        remoteDeletions.push(result.applyComplete);
      }
    }

    const summary = {
      config: {
        measuredSamples: options.samples,
        warmupSamples: options.warmup
      },
      localInsertions: buildStats(localInsertions),
      localDeletions: buildStats(localDeletions),
      remoteInsertions: buildStats(remoteInsertions),
      remoteDeletions: buildStats(remoteDeletions)
    };

    this.operationSummary.innerHTML = `
      <h3 class="benchmark-summary-title">Local Insertions</h3>
      ${renderStats(summary.localInsertions)}
      <h3 class="benchmark-summary-title">Local Deletions</h3>
      ${renderStats(summary.localDeletions)}
      <h3 class="benchmark-summary-title">Remote Insertions (End-To-End)</h3>
      ${renderStats(summary.remoteInsertions)}
      <h3 class="benchmark-summary-title">Remote Deletions (End-To-End)</h3>
      ${renderStats(summary.remoteDeletions)}
    `;

    this.setOperationHeaders('Local Insert', 'Remote Insert E2E', 'Local Delete', 'Remote Delete E2E');
    this.operationResultsBody.innerHTML = localInsertions.map((value, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${formatMs(value)}</td>
        <td>${formatMs(remoteInsertions[index])}</td>
        <td>${formatMs(localDeletions[index])}</td>
        <td>${formatMs(remoteDeletions[index])}</td>
      </tr>
    `).join('');

    this.publishBenchmarkJson({
      suite: 'four-operations',
      summary: summary
    });
    this.setStatus('Ready');
    this.appendLog('4-operation benchmark completed.');
    this.isRunning = false;
    this.renderButtonState();
  }

  renderRawResults() {
    const oneWayStats = buildStats(this.rawResults.map(result => result.oneWay));
    const rttStats = buildStats(this.rawResults.map(result => result.rtt));
    const returnStats = buildStats(this.rawResults.map(result => result.returnPath));

    this.rawSummary.innerHTML = `
      <h3 class="benchmark-summary-title">One-Way Delivery</h3>
      ${renderStats(oneWayStats)}
      <h3 class="benchmark-summary-title">Round Trip Time</h3>
      ${renderStats(rttStats)}
      <h3 class="benchmark-summary-title">Return Path</h3>
      ${renderStats(returnStats)}
    `;

    this.rawResultsBody.innerHTML = this.rawResults.map((result, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${formatMs(result.oneWay)}</td>
        <td>${formatMs(result.rtt)}</td>
        <td>${formatMs(result.returnPath)}</td>
      </tr>
    `).join('');
  }

  renderOperationResults() {
    const transportStats = buildStats(this.operationResults.map(result => result.transport));
    const applyStats = buildStats(this.operationResults.map(result => result.applyComplete));
    const ackStats = buildStats(this.operationResults.map(result => result.ackRtt));

    this.operationSummary.innerHTML = `
      <h3 class="benchmark-summary-title">Transport To Receiver</h3>
      ${renderStats(transportStats)}
      <h3 class="benchmark-summary-title">End-To-End Apply Completion</h3>
      ${renderStats(applyStats)}
      <h3 class="benchmark-summary-title">Ack Round Trip Time</h3>
      ${renderStats(ackStats)}
    `;

    this.setOperationHeaders('Transport', 'Apply Complete', 'Ack RTT', 'Remote Processing');
    this.operationResultsBody.innerHTML = this.operationResults.map((result, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${formatMs(result.transport)}</td>
        <td>${formatMs(result.applyComplete)}</td>
        <td>${formatMs(result.ackRtt)}</td>
        <td>${formatMs(result.remoteProcessing)}</td>
      </tr>
    `).join('');

    this.publishBenchmarkJson({
      suite: 'insert-latency',
      summary: {
        transport: transportStats,
        applyComplete: applyStats,
        ackRtt: ackStats
      }
    });
  }

  setOperationHeaders(col1, col2, col3, col4) {
    if (this.operationHeader1) this.operationHeader1.textContent = col1;
    if (this.operationHeader2) this.operationHeader2.textContent = col2;
    if (this.operationHeader3) this.operationHeader3.textContent = col3;
    if (this.operationHeader4) this.operationHeader4.textContent = col4;
  }

  publishBenchmarkJson(result) {
    if (!this.benchmarkJson) return;
    this.benchmarkJson.textContent = JSON.stringify(result, null, 2);
    this.doc.body.dataset.benchmarkReady = 'true';
  }

  async teardown() {
    Object.keys(this.pendingPings).forEach(id => {
      window.clearTimeout(this.pendingPings[id].timeoutId);
      delete this.pendingPings[id];
    });

    Object.keys(this.pendingOperations).forEach(id => {
      window.clearTimeout(this.pendingOperations[id].timeoutId);
      delete this.pendingOperations[id];
    });

    if (this.connectionA) {
      try {
        this.connectionA.close();
      } catch (err) {}
    }

    if (this.connectionB) {
      try {
        this.connectionB.close();
      } catch (err) {}
    }

    if (this.peerA) {
      try {
        this.peerA.destroy();
      } catch (err) {}
    }

    if (this.peerB) {
      try {
        this.peerB.destroy();
      } catch (err) {}
    }

    this.connectionA = null;
    this.connectionB = null;
    this.peerA = null;
    this.peerB = null;
    this.channelOpenTime.textContent = 'Not connected';
  }

  handleError(err) {
    console.error('[LatencyBench] Error:', err);
    this.isRunning = false;
    this.renderButtonState();
    this.setStatus('Error');
    this.appendLog(err && err.message ? err.message : String(err));
    this.publishBenchmarkJson({
      suite: 'error',
      error: err && err.message ? err.message : String(err)
    });
  }
}

window.addEventListener('load', () => {
  const app = new BenchmarkApp();
  const params = getQueryParams();

  if (params.get('autorun') === '1') {
    const sampleCount = params.get('samples');
    const warmupCount = params.get('warmup');
    const payloadBytes = params.get('payloadBytes');
    const suite = params.get('suite') || 'four-operations';

    if (sampleCount) app.sampleCountInput.value = sampleCount;
    if (warmupCount) app.warmupCountInput.value = warmupCount;
    if (payloadBytes) app.payloadBytesInput.value = payloadBytes;

    app.initializePeers()
      .then(() => {
        if (suite === 'raw') {
          return app.runRawBenchmark();
        }

        if (suite === 'insert') {
          return app.runOperationBenchmark();
        }

        return app.runFourOperationBenchmark();
      })
      .catch(err => app.handleError(err));
  }
});
