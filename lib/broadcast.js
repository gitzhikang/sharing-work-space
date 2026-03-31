class Broadcast {
  constructor() {
    this.controller = null;
    this.peer = null;
    this.outConns = [];
    this.inConns = [];
    this.outgoingBuffer = [];
    this.MAX_BUFFER_SIZE = 40;
    this.currentStream = null;
    this.localMediaStream = null; // Track local media stream separately
    this.knownPeers = [];
    this.MAX_PEERS = 3;
    this.seenControlMessages = {};
    this.controlMessageCounter = 0;
  }

  send(operation) {
    const operationJSON = JSON.stringify(operation);
    if (operation.type === 'insert' || operation.type === 'delete') {
      this.addToOutgoingBuffer(operationJSON);
    }
    this.outConns.forEach(conn => conn.send(operationJSON));
  }

  addToOutgoingBuffer(operation) {
    if (this.outgoingBuffer.length === this.MAX_BUFFER_SIZE) {
      this.outgoingBuffer.shift();
    }

    this.outgoingBuffer.push(operation);
  }

  processOutgoingBuffer(peerId) {
    const connection = this.outConns.find(conn => conn.peer === peerId);
    this.outgoingBuffer.forEach(op => {
      connection.send(op);
    });
  }

  bindServerEvents(targetPeerId, peer) {
    this.peer = peer;
    this.onOpen(targetPeerId);
    this.onPeerConnection();
    this.onVideoCall();
    this.onError();
    this.onDisconnect();
    this.heartbeat = this.startPeerHeartBeat(peer);
  }

  startPeerHeartBeat(peer) {
    let timeoutId = 0;
    const heartbeat = () => {
      timeoutId = setTimeout(heartbeat, 20000);
      if (peer.socket._wsOpen()) {
        peer.socket.send({ type: 'HEARTBEAT' });
      }
    };

    heartbeat();

    return {
      start: function () {
        if (timeoutId === 0) { heartbeat(); }
      },
      stop: function () {
        clearTimeout(timeoutId);
        timeoutId = 0;
      }
    };
  }

  onOpen(targetPeerId) {
    const handleOpen = id => {
      this.controller.updateShareLink(id);

      if (targetPeerId == 0) {
        this.controller.addToNetwork(id, this.controller.siteId, this.controller.getSelfDisplayName());
      } else {
        this.requestConnection(targetPeerId, id, this.controller.siteId, this.controller.getSelfDisplayName())
      }
    };

    if (this.peer && this.peer.id) {
      handleOpen(this.peer.id);
      return;
    }

    this.peer.on('open', handleOpen);
  }

  onError() {
    this.peer.on("error", err => {
      console.error('PeerJS Error:', err.type, err);
      const pid = String(err).replace("Error: Could not connect to peer ", "");
      this.removeFromConnections(pid);
      console.log(err.type);
      if (!this.peer.disconnected) {
        this.controller.findNewTarget();
      }
      this.controller.enableEditor();
    });
  }

  onDisconnect() {
    this.peer.on('disconnected', () => {
      this.controller.lostConnection();
    });
  }

  requestConnection(target, peerId, siteId, name = null) {
    const conn = this.peer.connect(target);
    this.addToOutConns(conn);
    conn.on('open', () => {
      conn.send(JSON.stringify({
        type: 'connRequest',
        peerId: peerId,
        siteId: siteId,
        name: name,
      }));
    });
  }

  evaluateRequest(peerId, siteId, name = null) {
    if (this.hasReachedMax()) {
      this.forwardConnRequest(peerId, siteId, name);
    } else {
      this.acceptConnRequest(peerId, siteId, name);
    }
  }

  hasReachedMax() {
    const halfTheNetwork = Math.ceil(this.controller.network.length / 2);
    const tooManyInConns = this.inConns.length > Math.max(halfTheNetwork, 5);
    const tooManyOutConns = this.outConns.length > Math.max(halfTheNetwork, 5);

    return tooManyInConns || tooManyOutConns;
  }

  forwardConnRequest(peerId, siteId, name = null) {
    const connected = this.outConns.filter(conn => conn.peer !== peerId);
    const randomIdx = Math.floor(Math.random() * connected.length);
    connected[randomIdx].send(JSON.stringify({
      type: 'connRequest',
      peerId: peerId,
      siteId: siteId,
      name: name,
    }));
  }

  addToOutConns(connection) {
    if (!!connection && !this.isAlreadyConnectedOut(connection)) {
      this.outConns.push(connection);
    }
  }

  addToInConns(connection) {
    if (!!connection && !this.isAlreadyConnectedIn(connection)) {
      this.inConns.push(connection);
    }
  }

  addToNetwork(peerId, siteId, name = null) {
    this.send({
      type: "add to network",
      newPeer: peerId,
      newSite: siteId,
      newName: name
    });
  }

  removeFromNetwork(peerId) {
    this.send({
      type: "remove from network",
      oldPeer: peerId
    });
    this.controller.removeFromNetwork(peerId);
  }

  removeFromConnections(peer) {
    this.inConns = this.inConns.filter(conn => conn.peer !== peer);
    this.outConns = this.outConns.filter(conn => conn.peer !== peer);
    this.removeFromNetwork(peer);
  }

  isAlreadyConnectedOut(connection) {
    if (connection.peer) {
      return !!this.outConns.find(conn => conn.peer === connection.peer);
    } else {
      return !!this.outConns.find(conn => conn.peer.id === connection);
    }
  }

  isAlreadyConnectedIn(connection) {
    if (connection.peer) {
      return !!this.inConns.find(conn => conn.peer === connection.peer);
    } else {
      return !!this.inConns.find(conn => conn.peer.id === connection);
    }
  }

  onPeerConnection() {
    this.peer.on('connection', (connection) => {
      this.onConnection(connection);
      this.onData(connection);
      this.onConnClose(connection);
    });
  }

  acceptConnRequest(peerId, siteId, name = null) {
    const connBack = this.peer.connect(peerId);
    this.addToOutConns(connBack);
    this.controller.addToNetwork(peerId, siteId, name, this.controller.doc, false);

    const initialData = JSON.stringify({
      type: 'syncResponse',
      siteId: this.controller.siteId,
      peerId: this.peer.id,
      initialStruct: this.controller.crdt.struct,
      initialVersions: this.controller.vector.versions,
      network: this.controller.network,
      videoState: this.controller.exportVideoSyncState ? this.controller.exportVideoSyncState() : null
    });

    if (connBack.open) {
      connBack.send(initialData);
    } else {
      connBack.on('open', () => {
        connBack.send(initialData);
      });
    }
  }

  videoCall(id, ms) {
    // Close existing stream if any before making new call
    if (this.currentStream) {
      if (this.localMediaStream) {
        this.localMediaStream.getTracks().forEach(track => track.stop());
      }
      this.currentStream.close();
    }

    console.log('[Broadcast] Initiating video call to peer:', id);
    console.log('[Broadcast] Local stream tracks:', ms && ms.getTracks ? ms.getTracks().length : 0);

    this.localMediaStream = ms; // Save local stream
    const callObj = this.peer.call(id, ms);

    console.log('[Broadcast] Call object created, setting up stream listener');
    this.onStream(callObj);
  }

  onConnection(connection) {
    this.controller.updateRootUrl(connection.peer);
    this.addToInConns(connection);
  }

  onVideoCall() {
    this.peer.on('call', callObj => {
      if (this.controller.videoRoom) {
        this.controller.videoRoom.handleIncomingCall(callObj);
      } else {
        this.controller.beingCalled(callObj);
      }
    });
  }

  answerCall(callObj, ms) {
    // Close existing stream if any before answering new call
    if (this.currentStream) {
      if (this.localMediaStream) {
        this.localMediaStream.getTracks().forEach(track => track.stop());
      }
      this.currentStream.close();
    }

    console.log('[Broadcast] Answering call from peer:', callObj.peer);
    console.log('[Broadcast] Local stream tracks:', ms && ms.getTracks ? ms.getTracks().length : 0);

    this.localMediaStream = ms; // Save local stream
    callObj.answer(ms);
    this.controller.answerCall(callObj.peer);

    console.log('[Broadcast] Call answered, setting up stream listener');
    this.onStream(callObj);
  }

  onStream(callObj) {
    let streamHandled = false; // Prevent duplicate stream handling

    callObj.on('stream', stream => {
      if (streamHandled) {
        console.log('[Broadcast] Duplicate stream event ignored for peer:', callObj.peer);
        return;
      }

      console.log('[Broadcast] Received stream from peer:', callObj.peer);
      console.log('[Broadcast] Stream has tracks:', stream.getTracks().length);

      streamHandled = true;

      // Close previous stream if exists
      if (this.currentStream && this.currentStream !== callObj) {
        console.log('[Broadcast] Closing previous stream');
        this.currentStream.close();
      }

      this.currentStream = callObj;

      // Pass the local media stream along with the remote stream
      this.controller.streamVideo(stream, callObj, this.localMediaStream);

      callObj.on('close', () => this.onStreamClose(callObj.peer))
    });
  }

  onStreamClose(peerId) {
    console.log('[Broadcast] Stream closed by peer:', peerId);
    console.log('[Broadcast] Cleaning up local media streams and closing video UI');

    // Properly cleanup media streams
    if (this.localMediaStream) {
      console.log('[Broadcast] Stopping local media stream tracks');
      this.localMediaStream.getTracks().forEach(track => {
        track.stop();
        console.log('[Broadcast] Stopped local track:', track.kind);
      });
      this.localMediaStream = null;
    }
    this.currentStream = null;

    // Close video UI and notify user
    this.controller.closeVideo(peerId);
    if (this.controller.notifyPeerLeftCall) {
      this.controller.notifyPeerLeftCall(peerId);
    }
  }

  onData(connection) {
    connection.on('data', data => {
        const dataObj = JSON.parse(data);

      switch (dataObj.type) {
        case 'connRequest':
          this.evaluateRequest(dataObj.peerId, dataObj.siteId, dataObj.name);
          break;
        case 'syncResponse':
          this.processOutgoingBuffer(dataObj.peerId);
          this.updateKnownPeers(dataObj.network);
          this.controller.handleSync(dataObj);
          this.maintainConnections();
          break;
        case 'syncCompleted':
          this.processOutgoingBuffer(dataObj.peerId);
          break;
        case 'add to network':
          this.controller.addToNetwork(dataObj.newPeer, dataObj.newSite, dataObj.newName, this.controller.doc || document, false);
          this.addKnownPeer(dataObj.newPeer);
          this.maintainConnections();
          break;
        case 'remove from network':
          this.controller.removeFromNetwork(dataObj.oldPeer);
          this.removeKnownPeer(dataObj.oldPeer);
          break;
        case 'video-state':
          if (this.forwardControlMessage(dataObj, connection.peer) && this.controller.handleVideoStateMessage) {
            this.controller.handleVideoStateMessage(dataObj);
          }
          break;
        case 'sfu-config':
          if (this.forwardControlMessage(dataObj, connection.peer) && this.controller.handleSfuConfigMessage) {
            this.controller.handleSfuConfigMessage(dataObj);
          }
          break;
        case 'peer-name':
          if (this.forwardControlMessage(dataObj, connection.peer) && this.controller.handlePeerNameMessage) {
            this.controller.handlePeerNameMessage(dataObj);
          }
          break;
        default:
          this.controller.handleRemoteOperation(dataObj);
      }
    });
  }

  createControlMessageId(prefix = 'control') {
    this.controlMessageCounter += 1;
    return `${prefix}:${this.peer && this.peer.id ? this.peer.id : 'peer'}:${Date.now()}:${this.controlMessageCounter}`;
  }

  hasSeenControlMessage(messageId) {
    return !!this.seenControlMessages[messageId];
  }

  rememberControlMessage(messageId) {
    if (!messageId) return;
    this.seenControlMessages[messageId] = true;
  }

  getAllConnections() {
    const merged = this.outConns.concat(this.inConns);
    const unique = [];

    merged.forEach(conn => {
      if (!conn || !conn.peer) return;
      if (!unique.find(existing => existing.peer === conn.peer)) {
        unique.push(conn);
      }
    });

    return unique;
  }

  sendControlMessage(messageObj, excludePeerId = null) {
    const payload = JSON.stringify(messageObj);

    this.getAllConnections().forEach(conn => {
      if (excludePeerId && conn.peer === excludePeerId) return;

      try {
        if (conn.open !== false) {
          conn.send(payload);
        }
      } catch (err) {
        console.error('[Broadcast] Failed to send control message:', err);
      }
    });
  }

  broadcastControlMessage(messageObj) {
    const message = Object.assign({}, messageObj);

    if (!message.id) {
      message.id = this.createControlMessageId(message.type || 'control');
    }

    this.rememberControlMessage(message.id);
    this.sendControlMessage(message);
  }

  forwardControlMessage(messageObj, sourcePeerId) {
    if (!messageObj || !messageObj.id) {
      return false;
    }

    if (this.hasSeenControlMessage(messageObj.id)) {
      return false;
    }

    this.rememberControlMessage(messageObj.id);
    this.sendControlMessage(messageObj, sourcePeerId);
    return true;
  }

  randomId() {
    const possConns = this.inConns.filter(conn => {
      return this.peer.id !== conn.peer;
    });
    const randomIdx = Math.floor(Math.random() * possConns.length);
    if (possConns[randomIdx]) {
      return possConns[randomIdx].peer;
    } else {
      return false;
    }
  }

  onConnClose(connection) {
    connection.on('close', () => {
      this.removeFromConnections(connection.peer);
      if (connection.peer == this.controller.urlId) {
        const id = this.randomId();
        if (id) { this.controller.updatePageURL(id); }
      }

      // Try to maintain connection count
      this.maintainConnections();

      if (!this.hasReachedMax()) {
        this.controller.findNewTarget();
      }
    });
  }

  updateKnownPeers(networkList) {
    networkList.forEach(peerObj => {
      if (peerObj.peerId !== this.peer.id && !this.knownPeers.includes(peerObj.peerId)) {
        this.knownPeers.push(peerObj.peerId);
      }
    });
    console.log('Updated known peers:', this.knownPeers);
  }

  addKnownPeer(peerId) {
    if (peerId !== this.peer.id && !this.knownPeers.includes(peerId)) {
      this.knownPeers.push(peerId);
      console.log('Added new peer to known list:', peerId);
    }
  }

  removeKnownPeer(peerId) {
    this.knownPeers = this.knownPeers.filter(id => id !== peerId);
    console.log('Removed peer from known list:', peerId);
  }

  maintainConnections() {
    if (this.outConns.length >= this.MAX_PEERS) {
      return;
    }

    const needed = this.MAX_PEERS - this.outConns.length;
    if (needed <= 0) return;

    // Filter potential peers:
    // 1. Not already connected (outbound)
    // 2. Not already connected (inbound) - optional, but good to avoid double connections
    // 3. Not self (already filtered in knownPeers)
    const candidates = this.knownPeers.filter(id => {
      const isOut = this.outConns.some(c => c.peer === id);
      const isIn = this.inConns.some(c => c.peer === id);
      return !isOut && !isIn;
    });

    if (candidates.length === 0) {
      console.log('No new candidates to connect to.');
      return;
    }

    // Shuffle candidates to pick random ones
    const shuffled = candidates.sort(() => 0.5 - Math.random());
    const toConnect = shuffled.slice(0, needed);

    console.log(`Connecting to ${toConnect.length} new peers to maintain redundancy.`);

    toConnect.forEach(targetId => {
      this.requestConnection(targetId, this.peer.id, this.controller.siteId, this.controller.getSelfDisplayName());
    });
  }
}

export default Broadcast;
