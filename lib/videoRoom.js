import 'regenerator-runtime/runtime';
import { LocalAudioTrack, LocalVideoTrack, Room, RoomEvent } from 'livekit-client';

class VideoRoom {
  constructor(controller, broadcast, doc = document, win = window) {
    this.controller = controller;
    this.broadcast = broadcast;
    this.doc = doc;
    this.win = win;

    this.joined = false;
    this.mode = 'idle';
    this.localStream = null;
    this.meshCalls = {};
    this.videoParticipants = {};
    this.sharedSfuConfig = null;
    this.liveKitRoom = null;
    this.liveKitLocalTracks = [];
    this.liveKitTrackElements = {};
    this.isReconciling = false;
    this.needsReconcile = false;
    this.modeTransition = null;

    this.bindUI();
    this.renderUiState();
  }

  bindUI() {
    const joinBtn = this.doc.querySelector('#joinVideoBtn');
    const leaveBtn = this.doc.querySelector('#leaveVideoBtn');
    const shareBtn = this.doc.querySelector('#shareSfuBtn');
    const minimize = this.doc.querySelector('.minimize');
    const exit = this.doc.querySelector('.exit');
    const bar = this.doc.querySelector('.video-bar');

    if (joinBtn) {
      joinBtn.onclick = () => {
        this.joinVideo().catch(err => this.handleVideoError(err, 'Unable to join the video room.'));
      };
    }

    if (leaveBtn) {
      leaveBtn.onclick = () => {
        this.leaveVideo().catch(err => this.handleVideoError(err, 'Unable to leave the video room.'));
      };
    }

    if (shareBtn) {
      shareBtn.onclick = () => {
        this.shareSfuConfig().catch(err => this.handleVideoError(err, 'Unable to share the LiveKit configuration.'));
      };
    }

    if (minimize) {
      minimize.onclick = () => {
        if (bar) { bar.classList.toggle('mini'); }
        const stage = this.ensureStage();
        if (stage) {
          stage.classList.toggle('hide');
        }
      };
    }

    if (exit) {
      exit.onclick = () => {
        this.leaveVideo().catch(err => this.handleVideoError(err, 'Unable to close the video room.'));
      };
    }
  }

  getSelfPeerId() {
    return this.broadcast && this.broadcast.peer ? this.broadcast.peer.id : null;
  }

  getDefaultRoomName() {
    const fallbackId = this.controller && this.controller.urlId && this.controller.urlId !== 0
      ? this.controller.urlId
      : (this.getSelfPeerId() || 'room');

    return `conclave-${fallbackId}`;
  }

  getPeerName(peerId) {
    if (!peerId) return 'Peer';
    if (peerId === this.getSelfPeerId()) return 'You';

    const peerLi = this.controller && this.controller.getPeerElemById
      ? this.controller.getPeerElemById(peerId, this.doc)
      : this.doc.getElementById(peerId);

    if (peerLi && peerLi.children && peerLi.children[0] && peerLi.children[0].textContent) {
      return peerLi.children[0].textContent;
    }

    return peerId;
  }

  normalizeUrl(serverUrl) {
    const trimmed = (serverUrl || '').trim();

    if (trimmed.indexOf('https://') === 0) {
      return trimmed.replace('https://', 'wss://');
    }

    if (trimmed.indexOf('http://') === 0) {
      return trimmed.replace('http://', 'ws://');
    }

    return trimmed;
  }

  normalizeSfuConfig(config) {
    if (!config) return null;

    const normalized = {
      provider: 'livekit',
      serverUrl: this.normalizeUrl(config.serverUrl || config.wsUrl || config.url),
      apiKey: (config.apiKey || '').trim(),
      apiSecret: (config.apiSecret || '').trim(),
      roomName: (config.roomName || this.getDefaultRoomName()).trim(),
      providedBy: config.providedBy || this.getSelfPeerId(),
      updatedAt: Number(config.updatedAt || Date.now())
    };

    if (!normalized.serverUrl || !normalized.apiKey || !normalized.apiSecret || !normalized.roomName) {
      return null;
    }

    return normalized;
  }

  exportSyncState() {
    const participants = Object.keys(this.videoParticipants).map(peerId => ({
      peerId: peerId,
      joined: !!this.videoParticipants[peerId].joined,
      updatedAt: this.videoParticipants[peerId].updatedAt
    })).filter(entry => entry.joined);

    if (this.joined && this.getSelfPeerId() && !participants.find(entry => entry.peerId === this.getSelfPeerId())) {
      participants.push({
        peerId: this.getSelfPeerId(),
        joined: true,
        updatedAt: Date.now()
      });
    }

    return {
      participants: participants,
      sfuConfig: this.sharedSfuConfig
    };
  }

  importSyncState(syncState) {
    if (!syncState) return;

    if (syncState.participants && syncState.participants.forEach) {
      syncState.participants.forEach(entry => {
        this.updateParticipant(entry.peerId, !!entry.joined, entry.updatedAt || Date.now());
      });
    }

    if (syncState.sfuConfig) {
      this.applySharedSfuConfig(syncState.sfuConfig, false);
    }

    this.renderPeerIndicators();
    this.renderUiState();
    this.reconcileVideoMode();
  }

  updateParticipant(peerId, joined, updatedAt) {
    if (!peerId) return;

    if (peerId === this.getSelfPeerId()) {
      if (this.joined) {
        this.videoParticipants[peerId] = {
          joined: true,
          updatedAt: updatedAt || Date.now()
        };
      }
      return;
    }

    const existing = this.videoParticipants[peerId];
    if (existing && existing.updatedAt > updatedAt) {
      return;
    }

    if (joined) {
      this.videoParticipants[peerId] = {
        joined: true,
        updatedAt: updatedAt
      };
    } else {
      delete this.videoParticipants[peerId];
      this.cleanupRemoteParticipant(peerId);
    }
  }

  handleRemoteVideoState(message) {
    if (!message || !message.peerId) return;

    this.updateParticipant(message.peerId, !!message.joined, message.updatedAt || Date.now());
    this.renderPeerIndicators();
    this.renderUiState();
    this.reconcileVideoMode();
  }

  handleSharedSfuConfigMessage(message) {
    if (!message || !message.config) return;

    this.applySharedSfuConfig(message.config, false);
    this.renderUiState();
    this.reconcileVideoMode();
  }

  handlePeerDisconnected(peerId) {
    if (!peerId) return;

    delete this.videoParticipants[peerId];
    this.closeMeshCall(peerId, true);
    this.removeTile(peerId);
    this.detachLiveKitParticipant(peerId);
    this.renderPeerIndicators();
    this.renderUiState();
    this.reconcileVideoMode();
  }

  handlePeerShortcut() {
    if (!this.joined) {
      this.joinVideo().catch(err => this.handleVideoError(err, 'Unable to join the video room.'));
    }
  }

  showTransitionPrompt(targetMode, message) {
    const overlay = this.doc.querySelector('.mode-switch-overlay');
    const messageEl = this.doc.querySelector('.mode-switch-message');
    const titleEl = this.doc.querySelector('.mode-switch-title');
    const normalizedTarget = targetMode || 'video';

    this.modeTransition = normalizedTarget;
    this.showModal();

    if (titleEl) {
      titleEl.textContent = normalizedTarget === 'sfu' ? 'Switching To LiveKit SFU' : 'Switching Video Mode';
    }

    if (messageEl) {
      messageEl.textContent = message || 'Please wait while the room reconnects.';
    }

    if (overlay) {
      overlay.classList.remove('hide');
    }
  }

  hideTransitionPrompt() {
    const overlay = this.doc.querySelector('.mode-switch-overlay');

    this.modeTransition = null;

    if (overlay) {
      overlay.classList.add('hide');
    }
  }

  async shareSfuConfig() {
    const serverUrlInput = this.doc.querySelector('#sfuUrlInput');
    const apiKeyInput = this.doc.querySelector('#sfuApiKeyInput');
    const apiSecretInput = this.doc.querySelector('#sfuApiSecretInput');
    const roomInput = this.doc.querySelector('#sfuRoomInput');

    const config = this.normalizeSfuConfig({
      serverUrl: serverUrlInput ? serverUrlInput.value : '',
      apiKey: apiKeyInput ? apiKeyInput.value : '',
      apiSecret: apiSecretInput ? apiSecretInput.value : '',
      roomName: roomInput && roomInput.value ? roomInput.value : this.getDefaultRoomName(),
      providedBy: this.getSelfPeerId(),
      updatedAt: Date.now()
    });

    if (!config) {
      throw new Error('LiveKit requires a server URL, API key, API secret, and room name.');
    }

    this.applySharedSfuConfig(config, true);
    this.setSfuStatus(`Shared LiveKit room ${config.roomName} from ${config.serverUrl}.`);
  }

  applySharedSfuConfig(config, announce) {
    const normalized = this.normalizeSfuConfig(config);
    if (!normalized) return false;

    if (this.sharedSfuConfig && this.sharedSfuConfig.updatedAt > normalized.updatedAt) {
      return false;
    }

    this.sharedSfuConfig = normalized;

    const serverUrlInput = this.doc.querySelector('#sfuUrlInput');
    const apiKeyInput = this.doc.querySelector('#sfuApiKeyInput');
    const apiSecretInput = this.doc.querySelector('#sfuApiSecretInput');
    const roomInput = this.doc.querySelector('#sfuRoomInput');

    if (serverUrlInput) serverUrlInput.value = normalized.serverUrl;
    if (apiKeyInput) apiKeyInput.value = normalized.apiKey;
    if (apiSecretInput) apiSecretInput.value = normalized.apiSecret;
    if (roomInput) roomInput.value = normalized.roomName;

    if (announce && this.broadcast && this.broadcast.broadcastControlMessage) {
      this.broadcast.broadcastControlMessage({
        type: 'sfu-config',
        config: normalized
      });
    }

    if (this.mode === 'sfu' && this.liveKitRoom) {
      this.leaveSfuMode().then(() => this.reconcileVideoMode());
    }

    return true;
  }

  getActiveParticipantIds() {
    const ids = Object.keys(this.videoParticipants).filter(peerId => {
      const participant = this.videoParticipants[peerId];
      return participant && participant.joined;
    });

    const selfPeerId = this.getSelfPeerId();
    if (this.joined && selfPeerId && ids.indexOf(selfPeerId) === -1) {
      ids.push(selfPeerId);
    }

    return ids.filter(peerId => {
      return peerId === selfPeerId || this.controller.network.find(obj => obj.peerId === peerId);
    }).sort();
  }

  getActiveParticipantCount() {
    return this.getActiveParticipantIds().length;
  }

  getDesiredMode() {
    if (!this.joined) return 'idle';

    if (this.getActiveParticipantCount() >= 4 && this.sharedSfuConfig) {
      return 'sfu';
    }

    return 'mesh';
  }

  async joinVideo() {
    if (this.joined) {
      this.renderUiState();
      return;
    }

    if (!this.getSelfPeerId()) {
      throw new Error('PeerJS is still initializing. Please try again in a moment.');
    }

    await this.ensureLocalStream();

    this.joined = true;
    this.mode = 'mesh';
    this.videoParticipants[this.getSelfPeerId()] = {
      joined: true,
      updatedAt: Date.now()
    };
    this.controller.localMediaStream = this.localStream;

    this.showModal();
    this.attachStreamToTile(this.getSelfPeerId(), this.localStream, true);
    this.renderPeerIndicators();
    this.renderUiState();

    if (this.broadcast && this.broadcast.broadcastControlMessage) {
      this.broadcast.broadcastControlMessage({
        type: 'video-state',
        peerId: this.getSelfPeerId(),
        joined: true,
        updatedAt: Date.now()
      });
    }

    await this.reconcileVideoMode();
  }

  async leaveVideo() {
    const selfPeerId = this.getSelfPeerId();

    this.joined = false;
    this.mode = 'idle';
    delete this.videoParticipants[selfPeerId];

    if (this.broadcast && this.broadcast.broadcastControlMessage && selfPeerId) {
      this.broadcast.broadcastControlMessage({
        type: 'video-state',
        peerId: selfPeerId,
        joined: false,
        updatedAt: Date.now()
      });
    }

    this.leaveMeshMode();
    await this.leaveSfuMode();
    this.cleanupAllTiles();
    this.stopLocalStream();
    this.hideModal();
    this.renderPeerIndicators();
    this.renderUiState();
  }

  async ensureLocalStream(forceRefresh = false) {
    if (!forceRefresh && this.hasUsableLocalStream()) {
      return this.localStream;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera and microphone access is unavailable. Use Electron or an HTTPS origin.');
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (err) {
          console.error('[VideoRoom] Failed to stop stale local track:', err);
        }
      });
      this.localStream = null;
    }

    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    this.controller.localMediaStream = this.localStream;
    return this.localStream;
  }

  hasUsableLocalStream() {
    if (!this.localStream || !this.localStream.active) {
      return false;
    }

    const liveVideoTrack = this.getUsableTrack(this.localStream.getVideoTracks());
    const liveAudioTrack = this.getUsableTrack(this.localStream.getAudioTracks());

    return !!liveVideoTrack && !!liveAudioTrack;
  }

  getUsableTrack(tracks) {
    if (!tracks || tracks.length === 0) {
      return null;
    }

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (track && track.readyState === 'live' && track.enabled !== false) {
        return track;
      }
    }

    return null;
  }

  stopLocalStream() {
    if (!this.localStream) return;

    this.localStream.getTracks().forEach(track => {
      track.stop();
    });

    this.localStream = null;
    this.controller.localMediaStream = null;
    this.cleanupTileElement(this.getSelfPeerId());
  }

  async reconcileVideoMode() {
    if (this.isReconciling) {
      this.needsReconcile = true;
      return;
    }

    this.isReconciling = true;

    try {
      await this.reconcileVideoModeInner();
    } finally {
      this.isReconciling = false;

      if (this.needsReconcile) {
        this.needsReconcile = false;
        await this.reconcileVideoMode();
      }
    }
  }

  async reconcileVideoModeInner() {
    if (!this.joined) {
      this.hideTransitionPrompt();
      this.renderUiState();
      return;
    }

    const desiredMode = this.getDesiredMode();

    if (desiredMode === 'sfu') {
      const shouldPrompt = this.mode !== 'sfu';

      if (shouldPrompt) {
        this.showTransitionPrompt(
          'sfu',
          'A fourth video participant joined. Switching the room to LiveKit SFU now.'
        );
      }

      try {
        this.leaveMeshMode();
        await this.enterSfuMode();
      } finally {
        if (shouldPrompt) {
          this.hideTransitionPrompt();
        }
      }
      return;
    }

    if (this.mode === 'sfu') {
      this.showTransitionPrompt('mesh', 'Participant count dropped. Switching back to peer-to-peer mesh.');
      try {
        await this.leaveSfuMode();
        await this.ensureLocalStream(true);
      } finally {
        this.hideTransitionPrompt();
      }
    }

    this.mode = 'mesh';
    await this.ensureLocalStream();
    this.showModal();
    this.attachStreamToTile(this.getSelfPeerId(), this.localStream, true);
    this.reconcileMeshCalls();
    this.renderUiState();
  }

  shouldInitiateMeshCall(peerId) {
    const selfPeerId = this.getSelfPeerId();
    if (!selfPeerId || !peerId) return false;
    return String(selfPeerId) < String(peerId);
  }

  reconcileMeshCalls() {
    if (this.mode !== 'mesh' || !this.joined || !this.localStream) return;

    const activeRemotePeers = this.getActiveParticipantIds().filter(peerId => peerId !== this.getSelfPeerId());

    Object.keys(this.meshCalls).forEach(peerId => {
      if (activeRemotePeers.indexOf(peerId) === -1) {
        this.closeMeshCall(peerId, true);
      }
    });

    activeRemotePeers.forEach(peerId => {
      if (this.shouldInitiateMeshCall(peerId) && !this.meshCalls[peerId]) {
        this.placeMeshCall(peerId);
      }
    });
  }

  placeMeshCall(peerId) {
    if (!this.broadcast || !this.broadcast.peer || !this.localStream || this.meshCalls[peerId]) {
      return;
    }

    const callObj = this.broadcast.peer.call(peerId, this.localStream, {
      metadata: {
        videoRoom: true,
        roomName: this.sharedSfuConfig ? this.sharedSfuConfig.roomName : this.getDefaultRoomName()
      }
    });

    this.registerMeshCall(peerId, callObj);
  }

  handleIncomingCall(callObj) {
    if (!callObj || !callObj.peer) return;

    if (!callObj.metadata || !callObj.metadata.videoRoom) {
      if (callObj.close) {
        callObj.close();
      }
      return;
    }

    if (!this.joined || this.getDesiredMode() === 'sfu') {
      if (callObj.close) {
        callObj.close();
      }
      return;
    }

    this.ensureLocalStream()
      .then(stream => {
        this.mode = 'mesh';
        this.registerMeshCall(callObj.peer, callObj);
        callObj.answer(stream);
      })
      .catch(err => {
        this.handleVideoError(err, 'Unable to answer the mesh video call.');
        if (callObj.close) {
          callObj.close();
        }
      });
  }

  registerMeshCall(peerId, callObj) {
    if (!peerId || !callObj) return;

    const existing = this.meshCalls[peerId];
    if (existing && existing !== callObj) {
      this.closeMeshCall(peerId, false, existing);
    }

    this.meshCalls[peerId] = callObj;

    callObj.on('stream', stream => {
      this.attachStreamToTile(peerId, stream, false);
      this.showModal();
    });

    callObj.on('close', () => {
      this.unregisterMeshCall(peerId, callObj, true);
    });

    callObj.on('error', err => {
      console.error('[VideoRoom] Mesh call error:', err);
      this.closeMeshCall(peerId, true, callObj);
    });
  }

  unregisterMeshCall(peerId, callObj, preserveState) {
    const currentCall = this.meshCalls[peerId];

    if (callObj && currentCall && currentCall !== callObj) {
      return false;
    }

    if (currentCall && (!callObj || currentCall === callObj)) {
      delete this.meshCalls[peerId];
    }

    if (preserveState !== false && !this.meshCalls[peerId]) {
      this.removeTile(peerId);
    }

    return true;
  }

  closeMeshCall(peerId, preserveState, targetCallObj = null) {
    const callObj = targetCallObj || this.meshCalls[peerId];
    if (!callObj) {
      if (preserveState !== false && !this.meshCalls[peerId]) {
        this.removeTile(peerId);
      }
      return;
    }

    const detached = this.unregisterMeshCall(peerId, callObj, preserveState);
    if (!detached) {
      return;
    }

    if (callObj.close && !callObj.__videoRoomClosing) {
      try {
        callObj.__videoRoomClosing = true;
        callObj.close();
      } catch (err) {
        console.error('[VideoRoom] Failed to close mesh call:', err);
      }
    }
  }

  leaveMeshMode() {
    Object.keys(this.meshCalls).forEach(peerId => {
      this.closeMeshCall(peerId, true);
    });

    this.meshCalls = {};
  }

  async enterSfuMode() {
    if (this.mode === 'sfu' && this.liveKitRoom) {
      this.renderUiState();
      return;
    }

    if (!this.sharedSfuConfig) {
      this.mode = 'mesh';
      this.renderUiState();
      return;
    }

    await this.ensureLocalStream();

    try {
      const token = await this.createLiveKitToken(
        this.sharedSfuConfig.apiKey,
        this.sharedSfuConfig.apiSecret,
        this.sharedSfuConfig.roomName,
        this.getSelfPeerId(),
        this.getPeerName(this.getSelfPeerId())
      );

      const room = new Room();
      this.liveKitRoom = room;
      this.mode = 'sfu';

      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (this.liveKitRoom !== room) return;
        this.attachLiveKitTrack(participant.identity, participant.name || this.getPeerName(participant.identity), track);
      });

      room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        if (this.liveKitRoom !== room) return;
        this.detachLiveKitTrack(participant.identity, track);
      });

      room.on(RoomEvent.ParticipantDisconnected, participant => {
        if (this.liveKitRoom !== room) return;
        this.detachLiveKitParticipant(participant.identity);
      });

      room.on(RoomEvent.Disconnected, () => {
        if (this.liveKitRoom !== room) return;
        this.cleanupLiveKitUi();
        if (this.joined) {
          this.mode = this.sharedSfuConfig ? 'sfu' : 'mesh';
        } else {
          this.mode = 'idle';
        }
        this.renderUiState();
      });

      await room.connect(this.sharedSfuConfig.serverUrl, token);
      await this.publishLocalTracksToSfu(room);

      this.showModal();
      this.attachStreamToTile(this.getSelfPeerId(), this.localStream, true);
      this.renderUiState();
    } catch (err) {
      this.liveKitRoom = null;
      this.mode = 'mesh';
      this.cleanupLiveKitUi();
      this.reconcileMeshCalls();
      throw err;
    }
  }

  async leaveSfuMode() {
    if (this.liveKitRoom) {
      this.liveKitLocalTracks = [];

      try {
        this.liveKitRoom.disconnect();
      } catch (err) {
        console.error('[VideoRoom] Failed to disconnect LiveKit room:', err);
      }
    }

    this.liveKitRoom = null;
    this.mode = this.joined ? 'mesh' : 'idle';
    this.cleanupLiveKitUi();
  }

  async publishLocalTracksToSfu(room) {
    const tracks = [];

    if (this.localStream.getVideoTracks().length > 0) {
      tracks.push(new LocalVideoTrack(this.localStream.getVideoTracks()[0]));
    }

    if (this.localStream.getAudioTracks().length > 0) {
      tracks.push(new LocalAudioTrack(this.localStream.getAudioTracks()[0]));
    }

    for (let i = 0; i < tracks.length; i++) {
      await room.localParticipant.publishTrack(tracks[i]);
    }

    this.liveKitLocalTracks = tracks;
  }

  attachLiveKitTrack(peerId, displayName, track) {
    if (!track) return;

    const tile = this.ensureTile(peerId, displayName);
    let elements = this.liveKitTrackElements[peerId];

    if (!elements) {
      elements = {};
      this.liveKitTrackElements[peerId] = elements;
    }

    if (track.kind === 'video') {
      const videoEl = this.ensureVideoElement(tile, false);
      track.attach(videoEl);
      elements.video = videoEl;
      this.playMediaElement(videoEl);
    } else if (track.kind === 'audio') {
      const audioEl = this.ensureAudioElement(tile);
      track.attach(audioEl);
      elements.audio = audioEl;
      this.playMediaElement(audioEl);
    }
  }

  detachLiveKitTrack(peerId, track) {
    const elements = this.liveKitTrackElements[peerId];
    if (!elements) return;

    if (track.kind === 'video' && elements.video) {
      track.detach(elements.video);
      elements.video.remove();
      delete elements.video;
    }

    if (track.kind === 'audio' && elements.audio) {
      track.detach(elements.audio);
      elements.audio.remove();
      delete elements.audio;
    }

    if (!elements.video && !elements.audio) {
      delete this.liveKitTrackElements[peerId];
      this.removeTile(peerId);
    }
  }

  detachLiveKitParticipant(peerId) {
    const elements = this.liveKitTrackElements[peerId];
    if (elements) {
      if (elements.video) {
        elements.video.remove();
      }
      if (elements.audio) {
        elements.audio.remove();
      }
      delete this.liveKitTrackElements[peerId];
    }

    this.removeTile(peerId);
  }

  cleanupLiveKitUi() {
    Object.keys(this.liveKitTrackElements).forEach(peerId => {
      this.detachLiveKitParticipant(peerId);
    });
    this.liveKitTrackElements = {};
  }

  cleanupRemoteParticipant(peerId) {
    this.closeMeshCall(peerId, true);
    this.detachLiveKitParticipant(peerId);
  }

  cleanupAllTiles() {
    const stage = this.ensureStage();
    if (stage) {
      stage.innerHTML = '';
    }
  }

  ensureStage() {
    const modal = this.doc.querySelector('.video-modal');
    if (!modal) return null;

    let stage = modal.querySelector('.video-stage');

    if (!stage) {
      stage = this.doc.createElement('div');
      stage.className = 'video-stage';
      modal.appendChild(stage);
    }

    return stage;
  }

  ensureTile(peerId, labelText) {
    const stage = this.ensureStage();
    if (!stage) return null;

    let tile = stage.querySelector(`[data-video-peer="${peerId}"]`);

    if (!tile) {
      tile = this.doc.createElement('div');
      tile.className = 'video-tile';
      tile.dataset.videoPeer = peerId;

      const mediaWrap = this.doc.createElement('div');
      mediaWrap.className = 'video-media-wrap';

      const label = this.doc.createElement('div');
      label.className = 'video-label';
      label.textContent = labelText;

      tile.appendChild(mediaWrap);
      tile.appendChild(label);
      stage.appendChild(tile);
    } else {
      const label = tile.querySelector('.video-label');
      if (label) {
        label.textContent = labelText;
      }
    }

    return tile;
  }

  ensureVideoElement(tile, muted) {
    const mediaWrap = tile.querySelector('.video-media-wrap');
    let videoEl = mediaWrap.querySelector('video');

    if (!videoEl) {
      videoEl = this.doc.createElement('video');
      videoEl.setAttribute('autoplay', '');
      videoEl.setAttribute('playsinline', '');
      videoEl.muted = !!muted;
      mediaWrap.appendChild(videoEl);
    }

    return videoEl;
  }

  ensureAudioElement(tile) {
    const mediaWrap = tile.querySelector('.video-media-wrap');
    let audioEl = mediaWrap.querySelector('audio');

    if (!audioEl) {
      audioEl = this.doc.createElement('audio');
      audioEl.setAttribute('autoplay', '');
      mediaWrap.appendChild(audioEl);
    }

    return audioEl;
  }

  attachStreamToTile(peerId, stream, isLocal) {
    if (!stream) return;

    const tile = this.ensureTile(peerId, this.getPeerName(peerId));
    if (!tile) return;

    const videoEl = this.ensureVideoElement(tile, !!isLocal);
    videoEl.srcObject = stream;
    videoEl.muted = !!isLocal;
    this.playMediaElement(videoEl);
  }

  playMediaElement(mediaEl) {
    if (!mediaEl || !mediaEl.play) return;

    const playPromise = mediaEl.play();

    if (playPromise && playPromise.catch) {
      playPromise.catch(err => {
        console.error('[VideoRoom] Failed to play media element:', err);
      });
    }
  }

  cleanupTileElement(peerId) {
    const tile = this.doc.querySelector(`[data-video-peer="${peerId}"]`);
    if (!tile) return;

    const videoEl = tile.querySelector('video');
    if (videoEl && videoEl.srcObject) {
      videoEl.srcObject = null;
    }
  }

  removeTile(peerId) {
    const tile = this.doc.querySelector(`[data-video-peer="${peerId}"]`);
    if (tile) {
      tile.remove();
    }
  }

  showModal() {
    const modal = this.doc.querySelector('.video-modal');
    if (modal) {
      modal.classList.remove('hide');
    }
  }

  hideModal() {
    const modal = this.doc.querySelector('.video-modal');
    if (modal) {
      modal.classList.add('hide');
    }
  }

  renderPeerIndicators() {
    const peerEls = this.doc.querySelectorAll('#peerId li');

    for (let i = 0; i < peerEls.length; i++) {
      peerEls[i].classList.remove('calling', 'beingCalled', 'answered');
    }

    Object.keys(this.videoParticipants).forEach(peerId => {
      const peerLi = this.controller.getPeerElemById(peerId, this.doc);
      if (peerLi && peerId !== this.getSelfPeerId()) {
        peerLi.classList.add('answered');
      }
    });
  }

  renderUiState() {
    const joinBtn = this.doc.querySelector('#joinVideoBtn');
    const leaveBtn = this.doc.querySelector('#leaveVideoBtn');
    const roomStatus = this.doc.querySelector('.video-room-status');
    const modeStatus = this.doc.querySelector('.video-mode-status');
    const sfuStatus = this.doc.querySelector('.sfu-share-status');

    if (joinBtn) {
      joinBtn.disabled = this.joined || !this.getSelfPeerId();
    }

    if (leaveBtn) {
      leaveBtn.disabled = !this.joined;
    }

    if (roomStatus) {
      if (this.joined) {
        roomStatus.textContent = `Video participants: ${this.getActiveParticipantCount()}`;
      } else {
        roomStatus.textContent = 'Video is off';
      }
    }

    if (modeStatus) {
      if (!this.joined) {
        modeStatus.textContent = 'Mode: idle';
      } else if (this.modeTransition === 'sfu') {
        modeStatus.textContent = 'Mode: switching to LiveKit SFU';
      } else if (this.modeTransition === 'mesh') {
        modeStatus.textContent = 'Mode: switching to P2P mesh';
      } else if (this.mode === 'sfu') {
        modeStatus.textContent = 'Mode: LiveKit SFU';
      } else if (this.getActiveParticipantCount() >= 4 && !this.sharedSfuConfig) {
        modeStatus.textContent = 'Mode: Mesh (waiting for shared LiveKit config)';
      } else {
        modeStatus.textContent = 'Mode: P2P mesh';
      }
    }

    if (sfuStatus) {
      if (this.sharedSfuConfig) {
        sfuStatus.textContent = `Shared LiveKit room ${this.sharedSfuConfig.roomName} on ${this.sharedSfuConfig.serverUrl}`;
      } else {
        sfuStatus.textContent = 'No shared LiveKit configuration yet';
      }
    }
  }

  setSfuStatus(message) {
    const sfuStatus = this.doc.querySelector('.sfu-share-status');
    if (sfuStatus) {
      sfuStatus.textContent = message;
    }
  }

  handleVideoError(err, fallbackMessage) {
    const message = err && err.message ? err.message : fallbackMessage;
    console.error('[VideoRoom] Error:', err);
    this.hideTransitionPrompt();
    this.setSfuStatus(message);
    if (this.controller && this.controller.showConnectStatus) {
      this.controller.showConnectStatus(message, 'error', this.doc);
    }
  }

  async createLiveKitToken(apiKey, apiSecret, roomName, identity, name) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const payload = {
      iss: apiKey,
      sub: identity,
      nbf: issuedAt - 10,
      exp: issuedAt + 3600,
      name: name,
      video: {
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true
      }
    };

    return this.signJwt(payload, apiSecret);
  }

  async signJwt(payload, secret) {
    if (!this.win.crypto || !this.win.crypto.subtle) {
      throw new Error('Web Crypto is unavailable, so LiveKit tokens cannot be generated.');
    }

    const encoder = new TextEncoder();
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = this.base64UrlEncode(encoder.encode(JSON.stringify(header)));
    const encodedPayload = this.base64UrlEncode(encoder.encode(JSON.stringify(payload)));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const key = await this.win.crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await this.win.crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
    const signature = this.base64UrlEncode(new Uint8Array(signatureBuffer));

    return `${signingInput}.${signature}`;
  }

  base64UrlEncode(bytes) {
    let binary = '';

    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }

    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
}

export default VideoRoom;
