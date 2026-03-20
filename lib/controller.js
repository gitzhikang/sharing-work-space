import Editor from './editor';
import CRDT from './crdt';
import Char from './char';
import Identifier from './identifier';
import VersionVector from './versionVector';
import Version from './version';
import Broadcast from './broadcast';
import VideoRoom from './videoRoom';
import UUID from 'uuid/v1';
import { generateItemFromHash } from './hashAlgo';
import CSS_COLORS from './cssColors';
import { ANIMALS } from './cursorNames';
import Feather from 'feather-icons';

class Controller {
  constructor(targetPeerId, host, peer, broadcast, editor, doc = document, win = window) {
    this.siteId = UUID();
    this.host = host;
    this.doc = doc;
    this.win = win;
    this.buffer = [];
    this.calling = [];
    this.network = [];
    this.urlId = targetPeerId;
    this.localMediaStream = null;
    this.activeVideoPeer = null; // Track currently active video peer
    this.makeOwnName(doc);

    if (targetPeerId == 0) this.enableEditor();

    this.broadcast = broadcast;
    this.broadcast.controller = this;
    this.broadcast.bindServerEvents(targetPeerId, peer);

    this.editor = editor;
    this.editor.controller = this;
    this.editor.bindChangeEvent();

    this.vector = new VersionVector(this.siteId);
    this.crdt = new CRDT(this);
    this.editor.bindButtons();
    this.bindCopyEvent(doc);

    // Video functionality has been updated for Chrome compatibility
    this.attachEvents(doc, win);
    this.bindWindowEvents(win);
    this.videoRoom = new VideoRoom(this, this.broadcast, doc, win);
  }

  bindWindowEvents(win = window) {
    win.addEventListener('beforeunload', () => {
      if (this.broadcast && this.broadcast.peer && this.broadcast.peer.id) {
        this.broadcast.removeFromNetwork(this.broadcast.peer.id);
      }
    });
  }

  bindCopyEvent(doc = document) {
    const copyBtn = doc.querySelector('.copy-btn');
    if (copyBtn) {
      copyBtn.onclick = () => {
        this.copyToClipboard(doc.querySelector('#myLinkInput'));
      };
    }
  }

  copyToClipboard(element) {
    // Copy just the peer ID shown in the input
    const peerId = element.value ? element.value.trim() : '';

    // Check if peer ID has been generated
    if (!peerId || peerId === '') {
      console.error('Peer ID not yet generated. Please wait for PeerJS connection.');
      alert('Peer ID is not ready yet. Please wait a moment and try again.');
      return;
    }

    console.log('Copying peer ID to clipboard:', peerId);

    // Use modern clipboard API if available, fallback to old method
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(peerId)
        .then(() => {
          console.log('Successfully copied peer ID to clipboard');
          this.showCopiedStatus();
        })
        .catch(err => {
          console.error('Clipboard API failed:', err);
          this.fallbackCopyToClipboard(peerId);
        });
    } else {
      this.fallbackCopyToClipboard(peerId);
    }
  }

  fallbackCopyToClipboard(content) {
    const temp = document.createElement("input");
    document.querySelector("body").appendChild(temp);
    temp.value = content;
    temp.select();

    try {
      const successful = document.execCommand("copy");
      if (successful) {
        console.log('Successfully copied to clipboard (fallback method)');
        this.showCopiedStatus();
      } else {
        console.error('Copy command failed');
        alert('Failed to copy. Please try selecting and copying manually.');
      }
    } catch (err) {
      console.error('Error copying to clipboard:', err);
      alert('Failed to copy. Please try selecting and copying manually.');
    }

    temp.remove();
  }

  showCopiedStatus() {
    document.querySelector('.copy-status').classList.add('copied');

    setTimeout(() => document.querySelector('.copy-status').classList.remove('copied'), 1000);
  }

  attachEvents(doc = document, win = window) {
    let xPos = 0;
    let yPos = 0;
    const modal = doc.querySelector('.video-modal');
    const dragModal = e => {
      xPos = e.clientX - modal.offsetLeft;
      yPos = e.clientY - modal.offsetTop;
      win.addEventListener('mousemove', modalMove, true);
    }
    const setModal = () => { win.removeEventListener('mousemove', modalMove, true); }
    const modalMove = e => {
      modal.style.position = 'absolute';
      modal.style.top = (e.clientY - yPos) + 'px';
      modal.style.left = (e.clientX - xPos) + 'px';
    };

    doc.querySelector('.video-modal').addEventListener('mousedown', dragModal, false);
    win.addEventListener('mouseup', setModal, false);

    this.bindCopyEvent(doc);
    this.bindConnectEvent(doc);
  }

  bindConnectEvent(doc = document) {
    const connectBtn = doc.querySelector('#connectBtn');
    const peerIdInput = doc.querySelector('#peerIdInput');
    const connectStatus = doc.querySelector('.connect-status');

    if (connectBtn && peerIdInput) {
      connectBtn.onclick = () => {
        this.connectToPeer(peerIdInput.value.trim(), doc);
      };

      // Support Enter key connection
      peerIdInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          this.connectToPeer(peerIdInput.value.trim(), doc);
        }
      });
    }
  }

  connectToPeer(targetPeerId, doc = document) {
    const connectStatus = doc.querySelector('.connect-status');
    const peerIdInput = doc.querySelector('#peerIdInput');

    if (!targetPeerId || targetPeerId === '') {
      this.showConnectStatus('Please enter a Peer ID', 'error', doc);
      return;
    }

    if (!this.broadcast.peer || !this.broadcast.peer.id) {
      this.showConnectStatus('Please wait, initializing...', 'error', doc);
      return;
    }

    if (targetPeerId === this.broadcast.peer.id) {
      this.showConnectStatus('Cannot connect to yourself', 'error', doc);
      return;
    }

    // Check if already connected
    if (this.broadcast.isAlreadyConnectedOut(targetPeerId)) {
      this.showConnectStatus('Already connected to this peer', 'error', doc);
      return;
    }

    console.log('Attempting to connect to peer:', targetPeerId);
    this.showConnectStatus('Connecting...', 'info', doc);

    // Call broadcast connection method
    this.broadcast.requestConnection(targetPeerId, this.broadcast.peer.id, this.siteId);

    // Clear input box
    if (peerIdInput) {
      peerIdInput.value = '';
    }


  }

  showConnectStatus(message, type, doc = document) {
    const connectStatus = doc.querySelector('.connect-status');
    if (connectStatus) {
      connectStatus.textContent = message;
      connectStatus.className = 'connect-status ' + type;

      // Clear status after 3 seconds
      setTimeout(() => {
        connectStatus.textContent = '';
        connectStatus.className = 'connect-status';
      }, 3000);
    }
  }

  lostConnection() {
    console.log('disconnected');
  }

  updateShareLink(id, doc = document) {
    console.log('PeerJS connection established with ID:', id);
    const inputElement = doc.querySelector('#myLinkInput');

    // Only show the peer ID in the UI (cleaner), store full URL as data attribute
    inputElement.value = id;
    inputElement.dataset.fullUrl = this.host + '?' + id;
    console.log('Share link updated. Peer ID:', id, 'Full URL:', inputElement.dataset.fullUrl);
  }

  updatePageURL(id, win = window) {
    this.urlId = id;

    const newURL = this.host + '?' + id;
    win.history.pushState({}, '', newURL);
  }

  updateRootUrl(id, win = window) {
    if (this.urlId == 0) {
      this.updatePageURL(id, win);
    }
  }

  enableEditor(doc = document) {
    console.log('[Controller] Enabling editor and hiding loading screen');

    // Show the main app
    const app = doc.getElementById('app');
    if (app) {
      app.classList.remove('hide');
      console.log('[Controller] App shown');
    }

    // Hide the loading screen
    const loading = doc.querySelector('.loading');
    if (loading) {
      loading.style.display = 'none';
      console.log('[Controller] Loading screen hidden');
    }
  }

  populateCRDT(initialStruct) {
    const struct = initialStruct.map(line => {
      return line.map(ch => {
        return new Char(ch.value, ch.counter, ch.siteId, ch.position.map(id => {
          return new Identifier(id.digit, id.siteId);
        }));
      });
    });

    this.crdt.struct = struct;
    this.editor.replaceText(this.crdt.toText());
  }

  populateVersionVector(initialVersions) {
    const versions = initialVersions.map(ver => {
      let version = new Version(ver.siteId);
      version.counter = ver.counter;
      ver.exceptions.forEach(ex => version.exceptions.push(ex));
      return version;
    });

    versions.forEach(version => this.vector.versions.push(version));
  }

  addToNetwork(peerId, siteId, doc = document) {
    if (!this.network.find(obj => obj.siteId === siteId)) {
      this.network.push({ peerId, siteId });
      if (siteId !== this.siteId) {
        this.addToListOfPeers(siteId, peerId, doc);
      }

      this.broadcast.addToNetwork(peerId, siteId);
      if (this.videoRoom) {
        this.videoRoom.renderPeerIndicators();
        this.videoRoom.renderUiState();
      }
    }
  }

  removeFromNetwork(peerId, doc = document) {
    const peerObj = this.network.find(obj => obj.peerId === peerId);
    const idx = this.network.indexOf(peerObj);
    if (idx >= 0) {
      const deletedObj = this.network.splice(idx, 1)[0];
      this.removeFromListOfPeers(peerId, doc);
      this.editor.removeCursor(deletedObj.siteId);
      this.broadcast.removeFromNetwork(peerId);
      if (this.videoRoom) {
        this.videoRoom.handlePeerDisconnected(peerId);
      }
    }
  }

  makeOwnName(doc = document) {
    const listItem = doc.createElement('li');
    const node = doc.createElement('span');
    const textnode = doc.createTextNode("(You)")
    const color = generateItemFromHash(this.siteId, CSS_COLORS);
    const name = generateItemFromHash(this.siteId, ANIMALS);

    node.textContent = name;
    node.style.backgroundColor = color;
    node.classList.add('peer');

    listItem.appendChild(node);
    listItem.appendChild(textnode);
    doc.querySelector('#peerId').appendChild(listItem);
  }

  addToListOfPeers(siteId, peerId, doc = document) {
    const listItem = doc.createElement('li');
    const node = doc.createElement('span');

    // // purely for mock testing purposes
    //   let parser;
    //   if (typeof DOMParser === 'object') {
    //     parser = new DOMParser();
    //   } else {
    //     parser = {
    //       parseFromString: function() {
    //         return { firstChild: doc.createElement('div') }
    //       }
    //     }
    //   }

    let parser;
    if (typeof DOMParser === 'function') {
      parser = new DOMParser();
    } else if (this.win && this.win.DOMParser) {
      parser = new this.win.DOMParser();
    } else {
      parser = {
        parseFromString: () => {
          return { firstChild: doc.createElement('span') };
        }
      };
    }

    const color = generateItemFromHash(siteId, CSS_COLORS);
    const name = generateItemFromHash(siteId, ANIMALS);

    // Video call icons
    const phone = parser.parseFromString(Feather.icons.phone.toSvg({ class: 'phone' }), "image/svg+xml");
    const phoneIn = parser.parseFromString(Feather.icons['phone-incoming'].toSvg({ class: 'phone-in' }), "image/svg+xml");
    const phoneOut = parser.parseFromString(Feather.icons['phone-outgoing'].toSvg({ class: 'phone-out' }), "image/svg+xml");
    const phoneCall = parser.parseFromString(Feather.icons['phone-call'].toSvg({ class: 'phone-call' }), "image/svg+xml");

    node.textContent = name;
    node.style.backgroundColor = color;
    node.classList.add('peer');

    this.attachVideoEvent(peerId, listItem);

    listItem.id = peerId;
    listItem.appendChild(node);
    listItem.appendChild(phone.firstChild);
    listItem.appendChild(phoneIn.firstChild);
    listItem.appendChild(phoneOut.firstChild);
    listItem.appendChild(phoneCall.firstChild);
    doc.querySelector('#peerId').appendChild(listItem);

    if (this.videoRoom) {
      this.videoRoom.renderPeerIndicators();
    }
  }

  getPeerElemById(peerId, doc = document) {
    return doc.getElementById(peerId);
  }

  beingCalled(callObj, doc = document) {
    const peerFlag = this.getPeerElemById(callObj.peer);

    this.addBeingCalledClass(callObj.peer);

    console.log('[Video] Being called by peer:', callObj.peer);

    // Check if getUserMedia is available
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error('[Video] getUserMedia is not supported. HTTPS is required (except on localhost).');
      console.error('[Video] navigator.mediaDevices:', navigator.mediaDevices);
      console.error('[Video] Current protocol:', window.location.protocol);
      console.error('[Video] Current hostname:', window.location.hostname);
      alert('Video chat requires HTTPS. Please access this site via HTTPS or use localhost for development.');
      this.removeBeingCalledClass(callObj.peer, doc);
      return;
    }

    // Reuse existing media stream if available and active
    if (this.localMediaStream && this.localMediaStream.active) {
      console.log('[Video] Reusing existing media stream');
      console.log('[Video] Stream tracks:', this.localMediaStream.getTracks().map(t => ({
        kind: t.kind,
        label: t.label,
        enabled: t.enabled,
        readyState: t.readyState
      })));

      peerFlag.onclick = () => {
        this.broadcast.answerCall(callObj, this.localMediaStream);
      };
    } else {
      // Request new media stream
      console.log('[Video] Requesting new media stream (audio: true, video: true)...');

      navigator.mediaDevices.getUserMedia({ audio: true, video: true })
        .then(ms => {
          console.log('[Video] Media access granted successfully');
          console.log('[Video] MediaStream tracks:', ms.getTracks().map(t => ({
            kind: t.kind,
            label: t.label,
            enabled: t.enabled,
            readyState: t.readyState
          })));

          this.localMediaStream = ms;
          peerFlag.onclick = () => {
            this.broadcast.answerCall(callObj, ms);
          };
        })
        .catch(err => {
          console.error('[Video] Error accessing media devices');
          console.error('[Video] Error name:', err.name);
          console.error('[Video] Error message:', err.message);
          console.error('[Video] Error stack:', err.stack);
          console.error('[Video] Full error object:', err);

          let errorMessage = 'Camera/microphone access denied. ';

          if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            errorMessage += 'Please grant permissions in your browser and system settings.';
            console.error('[Video] Permission was explicitly denied by user or system.');
            console.error('[Video] Check: System Preferences > Security & Privacy > Camera/Microphone');
          } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
            errorMessage += 'No camera or microphone found on your device.';
            console.error('[Video] No media devices found.');
          } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
            errorMessage += 'Camera or microphone is already in use by another application.';
            console.error('[Video] Device is in use or hardware error occurred.');
          } else if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
            errorMessage += 'Camera or microphone settings are not compatible.';
            console.error('[Video] Constraints could not be satisfied.');
          } else if (err.name === 'SecurityError') {
            errorMessage += 'Access blocked due to security restrictions. Use HTTPS.';
            console.error('[Video] Security error - may need HTTPS or user gesture.');
          } else {
            errorMessage += 'Unknown error: ' + err.message;
            console.error('[Video] Unknown error type.');
          }

          alert(errorMessage);
          this.removeBeingCalledClass(callObj.peer, doc);
        });
    }
  }

  removeBeingCalledClass(peerId, doc = document) {
    const peerLi = doc.getElementById(peerId);
    if (peerLi) {
      peerLi.classList.remove('beingCalled');
    }
  }

  getPeerFlagById(peerId, doc = document) {
    const peerLi = doc.getElementById(peerId);
    return peerLi.children[0];
  }

  addBeingCalledClass(peerId, doc = document) {
    const peerLi = doc.getElementById(peerId);

    peerLi.classList.add('beingCalled');
  }

  addCallingClass(peerId, doc = document) {
    const peerLi = doc.getElementById(peerId);

    peerLi.classList.add('calling');
  }

  streamVideo(stream, callObj, localStream = null, doc = document) {
    // Prevent duplicate calls for the same peer
    if (this.activeVideoPeer === callObj.peer) {
      console.log('[Video] Ignoring duplicate streamVideo call for peer:', callObj.peer);
      return;
    }

    console.log('[Video] Starting to stream video from peer:', callObj.peer);
    console.log('[Video] Remote stream tracks:', stream.getTracks().map(t => ({
      kind: t.kind,
      label: t.label,
      enabled: t.enabled,
      readyState: t.readyState
    })));

    this.activeVideoPeer = callObj.peer; // Mark this peer as active

    const peerFlag = this.getPeerFlagById(callObj.peer, doc);
    const color = peerFlag.style.backgroundColor;
    const peerName = peerFlag.textContent;
    const modal = doc.querySelector('.video-modal');
    const bar = doc.querySelector('.video-bar');

    if (!modal) {
      console.error('[Video] Error: video modal not found in DOM');
      return;
    }

    this.answerCall(callObj.peer, doc);

    modal.classList.remove('hide');
    bar.style.backgroundColor = color;

    console.log('[Video] YOUR video as MAIN, remote as PIP');

    // Ensure we have a main video element (might have been removed when closing previous call)
    let mainVid = doc.querySelector('.video-modal video');
    if (!mainVid) {
      console.log('[Video] Main video element missing, creating new one');
      mainVid = doc.createElement('video');
      mainVid.setAttribute('autoplay', '');
      mainVid.setAttribute('playsinline', '');
      mainVid.setAttribute('controls', '');
      mainVid.muted = true;

      // Insert video after the video-bar
      if (bar && bar.nextSibling) {
        modal.insertBefore(mainVid, bar.nextSibling);
      } else {
        modal.appendChild(mainVid);
      }
      console.log('[Video] Created new video element:', mainVid);
    }

    // Verify mainVid is not null before using
    if (!mainVid) {
      console.error('[Video] Error: failed to create or find main video element');
      return;
    }

    // Display YOUR video as the MAIN video (full screen)
    const localVideoStream = localStream || callObj.localStream;
    if (localVideoStream) {
      console.log('[Video] Setting YOUR video as main video');
      mainVid.srcObject = localVideoStream;
      mainVid.muted = true; // Mute your own video to avoid feedback

      const playPromise = mainVid.play();
      if (playPromise !== undefined) {
        playPromise.catch(err => {
          console.error('Error playing main (your) video:', err);
        });
      }
    }

    // Display remote person's video side-by-side (this will also wrap mainVid)
    if (stream) {
      console.log('[Video] Setting remote video side-by-side');
      this.showRemoteVideoPIP(stream, peerName, doc);
    }

    // Add labels after both videos are set up
    const mainWrapper = modal.querySelector('.main-video-wrapper');
    if (mainWrapper) {
      this.addVideoLabel(mainWrapper, 'You', 'main-video-label');
    }

    this.bindVideoEvents(callObj, doc);
  }

  showRemoteVideoPIP(remoteStream, peerName, doc = document) {
    const modal = doc.querySelector('.video-modal');

    // Create a container for vertical layout if it doesn't exist
    let videoContainer = modal.querySelector('.video-container');
    if (!videoContainer) {
      videoContainer = doc.createElement('div');
      videoContainer.className = 'video-container';
      videoContainer.style.display = 'flex';
      videoContainer.style.flexDirection = 'column';
      videoContainer.style.gap = '10px';
      videoContainer.style.padding = '10px';
      videoContainer.style.height = '100%';
      videoContainer.style.width = '100%';
      videoContainer.style.boxSizing = 'border-box';
      videoContainer.style.overflow = 'auto';

      // Move existing main video into container
      const mainVid = modal.querySelector('video');
      if (mainVid) {
        // Wrap main video
        const mainWrapper = doc.createElement('div');
        mainWrapper.className = 'main-video-wrapper';
        mainWrapper.style.flex = '1';
        mainWrapper.style.position = 'relative';
        mainWrapper.style.minHeight = '200px';
        mainWrapper.style.minWidth = '0';
        mainWrapper.style.backgroundColor = '#000';
        mainWrapper.style.borderRadius = '8px';
        mainWrapper.style.overflow = 'hidden';
        mainWrapper.style.resize = 'vertical';
        mainWrapper.style.cursor = 'ns-resize';

        mainVid.style.width = '100%';
        mainVid.style.height = '100%';
        mainVid.style.objectFit = 'cover';

        // Insert container and move video into it
        const videoBar = modal.querySelector('.video-bar');
        if (videoBar && videoBar.nextSibling) {
          modal.insertBefore(videoContainer, videoBar.nextSibling);
        } else {
          modal.appendChild(videoContainer);
        }
        mainWrapper.appendChild(mainVid);
        videoContainer.appendChild(mainWrapper);
      }
    }

    // Create or get remote video element
    let remoteVid = doc.querySelector('.remote-video-pip');

    if (!remoteVid) {
      remoteVid = doc.createElement('video');
      remoteVid.className = 'remote-video-pip';
      remoteVid.setAttribute('autoplay', '');
      remoteVid.setAttribute('playsinline', '');
      remoteVid.muted = false; // Don't mute remote audio

      // Create wrapper for remote video
      const remoteWrapper = doc.createElement('div');
      remoteWrapper.className = 'remote-video-wrapper';
      remoteWrapper.style.flex = '1';
      remoteWrapper.style.position = 'relative';
      remoteWrapper.style.minHeight = '200px';
      remoteWrapper.style.minWidth = '0';
      remoteWrapper.style.backgroundColor = '#000';
      remoteWrapper.style.borderRadius = '8px';
      remoteWrapper.style.overflow = 'hidden';
      remoteWrapper.style.resize = 'vertical';
      remoteWrapper.style.cursor = 'ns-resize';

      remoteVid.style.width = '100%';
      remoteVid.style.height = '100%';
      remoteVid.style.objectFit = 'cover';
      remoteVid.style.pointerEvents = 'none';

      remoteWrapper.appendChild(remoteVid);
      videoContainer.appendChild(remoteWrapper);
    }

    remoteVid.srcObject = remoteStream;
    const playPromise = remoteVid.play();
    if (playPromise !== undefined) {
      playPromise.catch(err => {
        console.error('Error playing remote video:', err);
      });
    }

    // Add peer name label to remote video
    const remoteWrapper = remoteVid.closest('.remote-video-wrapper');
    if (remoteWrapper) {
      this.addVideoLabel(remoteWrapper, peerName, 'pip-video-label', remoteVid);
    }
  }

  addVideoLabel(container, labelText, className, videoElement = null) {
    // Remove existing label if any
    const existingLabel = container.querySelector(`.${className}`);
    if (existingLabel) {
      existingLabel.remove();
    }

    // Create new label
    const label = document.createElement('div');
    label.className = className;
    label.textContent = labelText;

    // Style the label
    label.style.position = 'absolute';
    label.style.top = '10px';
    label.style.left = '10px';
    label.style.color = 'white';
    label.style.backgroundColor = 'rgba(1, 33, 105, 0.9)'; // Duke Navy Blue with transparency
    label.style.padding = '6px 12px';
    label.style.borderRadius = '4px';
    label.style.fontSize = '13px';
    label.style.fontWeight = '600';
    label.style.fontFamily = '"InputMedium", sans-serif';
    label.style.zIndex = '10';
    label.style.pointerEvents = 'none';
    label.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';

    container.appendChild(label);
  }

  bindVideoEvents(callObj, doc = document) {
    const exit = doc.querySelector('.exit');
    const minimize = doc.querySelector('.minimize');
    const modal = doc.querySelector('.video-modal');
    const bar = doc.querySelector('.video-bar');
    const videoContainer = doc.querySelector('.video-container');
    const mainVid = doc.querySelector('.video-modal video');
    const remoteVid = doc.querySelector('.remote-video-pip');

    minimize.onclick = () => {
      bar.classList.toggle('mini');
      if (videoContainer) {
        videoContainer.classList.toggle('hide');
      }
    };

    exit.onclick = () => {
      console.log('[Video] Exit button clicked - closing call');

      modal.classList.add('hide');

      // Stop main video (your video)
      if (mainVid && mainVid.srcObject) {
        console.log('[Video] Stopping your video tracks');
        mainVid.srcObject.getTracks().forEach(track => track.stop());
        mainVid.srcObject = null;
      }

      // Stop remote video
      if (remoteVid && remoteVid.srcObject) {
        console.log('[Video] Stopping remote video tracks');
        remoteVid.srcObject.getTracks().forEach(track => track.stop());
        remoteVid.srcObject = null;
      }

      // Remove video container
      if (videoContainer) {
        videoContainer.remove();
      }

      // Update UI state
      const peerId = callObj.peer;
      const peerLi = this.getPeerElemById(peerId, doc);
      if (peerLi) {
        peerLi.classList.remove('answered', 'calling', 'beingCalled');
      }
      this.calling = this.calling.filter(id => id !== peerId);

      // Reset active video peer
      if (this.activeVideoPeer === peerId) {
        this.activeVideoPeer = null;
        console.log('[Video] Active video peer reset');
      }

      // Close the call - this will trigger 'close' event on remote peer
      console.log('[Video] Closing call object - remote peer will be notified');
      callObj.close();
    };
  }

  answerCall(peerId, doc = document) {
    const peerLi = doc.getElementById(peerId);

    if (peerLi) {
      peerLi.classList.remove('calling');
      peerLi.classList.remove('beingCalled');
      peerLi.classList.add('answered');
    }
  }

  notifyPeerLeftCall(peerId, doc = document) {
    const peerLi = this.getPeerElemById(peerId, doc);
    const peerName = peerLi ? peerLi.textContent : 'Peer';

    console.log(`[Video] ${peerName} left the video call`);

    // Show a brief notification (you can enhance this with a toast notification)
    const connectStatus = doc.querySelector('.connect-status');
    if (connectStatus) {
      connectStatus.textContent = `${peerName} left the call`;
      connectStatus.style.color = '#f56565'; // Red color
      connectStatus.style.opacity = '1';

      // Fade out after 3 seconds
      setTimeout(() => {
        connectStatus.style.opacity = '0';
        setTimeout(() => {
          connectStatus.textContent = '';
        }, 500);
      }, 3000);
    }
  }

  closeVideo(peerId, doc = document) {
    console.log('[Video] Closing video for peer:', peerId);

    const modal = doc.querySelector('.video-modal');
    const videoContainer = doc.querySelector('.video-container');
    const mainVid = doc.querySelector('.video-modal video');
    const remoteVid = doc.querySelector('.remote-video-pip');
    const peerLi = this.getPeerElemById(peerId, doc);

    modal.classList.add('hide');

    // Properly cleanup main video stream (your video)
    if (mainVid && mainVid.srcObject) {
      console.log('[Video] Stopping main (your) video tracks');
      const mainTracks = mainVid.srcObject.getTracks();
      mainTracks.forEach(track => {
        track.stop();
        console.log('[Video] Stopped main track:', track.kind, track.label);
      });
      mainVid.srcObject = null;
    }

    // Properly cleanup remote video stream
    if (remoteVid) {
      if (remoteVid.srcObject) {
        console.log('[Video] Stopping remote video tracks');
        const remoteTracks = remoteVid.srcObject.getTracks();
        remoteTracks.forEach(track => {
          track.stop();
          console.log('[Video] Stopped remote track:', track.kind, track.label);
        });
        remoteVid.srcObject = null;
      }
      console.log('[Video] Remote video element cleaned');
    }

    // Remove video container (includes both videos and labels)
    if (videoContainer) {
      videoContainer.remove();
      console.log('[Video] Video container removed');
    }

    if (peerLi) {
      peerLi.classList.remove('answered', 'calling', 'beingCalled');
    }
    this.calling = this.calling.filter(id => id !== peerId);

    // Reset active video peer
    if (this.activeVideoPeer === peerId) {
      this.activeVideoPeer = null;
      console.log('[Video] Active video peer reset');
    }

    if (peerLi) {
      this.attachVideoEvent(peerId, peerLi);
    }

    console.log('[Video] Video cleanup completed for peer:', peerId);
  }

  attachVideoEvent(peerId, node) {
    node.onclick = () => {
      if (this.videoRoom) {
        this.videoRoom.handlePeerShortcut(peerId);
      }
    }
  }

  removeFromListOfPeers(peerId, doc = document) {
    const peerNode = doc.getElementById(peerId);
    if (peerNode) {
      peerNode.remove();
    }
  }

  findNewTarget() {
    const connected = this.broadcast.outConns.map(conn => conn.peer);
    const unconnected = this.network.filter(obj => {
      return connected.indexOf(obj.peerId) === -1;
    });

    const possibleTargets = unconnected.filter(obj => {
      return obj.peerId !== this.broadcast.peer.id
    });

    if (possibleTargets.length === 0) {
      this.broadcast.peer.on('connection', conn => this.updatePageURL(conn.peer));
    } else {
      const randomIdx = Math.floor(Math.random() * possibleTargets.length);
      const newTarget = possibleTargets[randomIdx].peerId;
      this.broadcast.requestConnection(newTarget, this.broadcast.peer.id, this.siteId);
    }
  }

  handleSync(syncObj, doc = document, win = window) {
    if (syncObj.peerId != this.urlId) { this.updatePageURL(syncObj.peerId, win); }

    syncObj.network.forEach(obj => this.addToNetwork(obj.peerId, obj.siteId, doc));

    if (this.videoRoom && syncObj.videoState) {
      this.videoRoom.importSyncState(syncObj.videoState);
    }

    if (this.crdt.totalChars() === 0) {
      this.populateCRDT(syncObj.initialStruct);
      this.populateVersionVector(syncObj.initialVersions);
    }
    this.enableEditor(doc);

    this.syncCompleted(syncObj.peerId);
  }

  syncCompleted(peerId) {
    const completedMessage = JSON.stringify({
      type: 'syncCompleted',
      peerId: this.broadcast.peer.id
    });

    let connection = this.broadcast.outConns.find(conn => conn.peer === peerId);

    if (connection) {
      connection.send(completedMessage);
    } else {
      connection = this.broadcast.peer.connect(peerId);
      this.broadcast.addToOutConns(connection);
      connection.on('open', () => {
        connection.send(completedMessage);
      });
    }
  }

  exportVideoSyncState() {
    if (!this.videoRoom) return null;
    return this.videoRoom.exportSyncState();
  }

  handleVideoStateMessage(message) {
    if (this.videoRoom) {
      this.videoRoom.handleRemoteVideoState(message);
    }
  }

  handleSfuConfigMessage(message) {
    if (this.videoRoom) {
      this.videoRoom.handleSharedSfuConfigMessage(message);
    }
  }

  handleRemoteOperation(operation) {
    if (this.vector.hasBeenApplied(operation.version)) return;

    if (operation.type === 'insert') {
      this.applyOperation(operation);
    } else if (operation.type === 'delete') {
      this.buffer.push(operation);
    }

    this.processDeletionBuffer();
    this.broadcast.send(operation);
  }

  processDeletionBuffer() {
    let i = 0;
    let deleteOperation;

    while (i < this.buffer.length) {
      deleteOperation = this.buffer[i];

      if (this.hasInsertionBeenApplied(deleteOperation)) {
        this.applyOperation(deleteOperation);
        this.buffer.splice(i, 1);
      } else {
        i++;
      }
    }
  }

  hasInsertionBeenApplied(operation) {
    const charVersion = { siteId: operation.char.siteId, counter: operation.char.counter };
    return this.vector.hasBeenApplied(charVersion);
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

  localDelete(startPos, endPos) {
    this.crdt.handleLocalDelete(startPos, endPos);
  }

  localInsert(chars, startPos) {
    for (let i = 0; i < chars.length; i++) {
      if (chars[i - 1] === '\n') {
        startPos.line++;
        startPos.ch = 0;
      }
      this.crdt.handleLocalInsert(chars[i], startPos);
      startPos.ch++;
    }
  }

  broadcastInsertion(char) {
    const operation = {
      type: 'insert',
      char: char,
      version: this.vector.getLocalVersion()
    };

    this.broadcast.send(operation);
  }

  broadcastDeletion(char, version) {
    const operation = {
      type: 'delete',
      char: char,
      version: version
    };

    this.broadcast.send(operation);
  }

  insertIntoEditor(value, pos, siteId) {
    const positions = {
      from: {
        line: pos.line,
        ch: pos.ch,
      },
      to: {
        line: pos.line,
        ch: pos.ch,
      }
    }

    this.editor.insertText(value, positions, siteId);
  }

  deleteFromEditor(value, pos, siteId) {
    let positions;

    if (value === "\n") {
      positions = {
        from: {
          line: pos.line,
          ch: pos.ch,
        },
        to: {
          line: pos.line + 1,
          ch: 0,
        }
      }
    } else {
      positions = {
        from: {
          line: pos.line,
          ch: pos.ch,
        },
        to: {
          line: pos.line,
          ch: pos.ch + 1,
        }
      }
    }

    this.editor.deleteText(value, positions, siteId);
  }
}

export default Controller;
