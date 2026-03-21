import VideoRoom from '../lib/videoRoom';
import { JSDOM } from 'jsdom';

describe('VideoRoom', () => {
  let dom, win, doc, broadcast, controller, videoRoom, originalMediaDevices;

  beforeEach(() => {
    originalMediaDevices = global.navigator ? global.navigator.mediaDevices : undefined;

    dom = new JSDOM(`<!DOCTYPE html>
      <button id="joinVideoBtn"></button>
      <button id="leaveVideoBtn"></button>
      <button id="shareSfuBtn"></button>
      <input id="sfuUrlInput" />
      <input id="sfuApiKeyInput" />
      <input id="sfuApiSecretInput" />
      <input id="sfuRoomInput" />
      <span class="video-room-status"></span>
      <span class="video-mode-status"></span>
      <span class="sfu-share-status"></span>
      <div class="video-modal hide">
        <div class="video-bar">
          <span class="video-modal-title"></span>
          <div class="video-bar-actions">
            <i class="minimize"></i>
            <i class="exit"></i>
          </div>
        </div>
        <div class="video-stage"></div>
        <div class="mode-switch-overlay hide">
          <p class="mode-switch-title"></p>
          <p class="mode-switch-message"></p>
        </div>
      </div>
      <ul id="peerId">
        <li id="peer-b"><span>Beta</span></li>
        <li id="peer-c"><span>Gamma</span></li>
        <li id="peer-d"><span>Delta</span></li>
      </ul>`);

    win = dom.window;
    doc = win.document;
    win.crypto = {
      subtle: {
        importKey: () => Promise.resolve('key'),
        sign: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer)
      }
    };
    win.btoa = value => Buffer.from(value, 'binary').toString('base64');

    broadcast = {
      peer: { id: 'peer-a' },
      broadcastControlMessage: function() {}
    };

    controller = {
      urlId: 'peer-a',
      network: [
        { peerId: 'peer-a', siteId: 'site-a' },
        { peerId: 'peer-b', siteId: 'site-b' },
        { peerId: 'peer-c', siteId: 'site-c' },
        { peerId: 'peer-d', siteId: 'site-d' }
      ],
      localMediaStream: null,
      getPeerElemById: function(peerId) {
        return doc.getElementById(peerId);
      },
      showConnectStatus: function() {}
    };

    videoRoom = new VideoRoom(controller, broadcast, doc, win);
  });

  afterEach(() => {
    if (global.navigator) {
      global.navigator.mediaDevices = originalMediaDevices;
    }
  });

  it('shares LiveKit config through the existing data channel', done => {
    spyOn(broadcast, 'broadcastControlMessage');
    doc.querySelector('#sfuUrlInput').value = 'https://livekit.example.com';
    doc.querySelector('#sfuApiKeyInput').value = 'key-123';
    doc.querySelector('#sfuApiSecretInput').value = 'secret-456';
    doc.querySelector('#sfuRoomInput').value = 'team-room';

    videoRoom.shareSfuConfig().then(() => {
      expect(broadcast.broadcastControlMessage).toHaveBeenCalled();
      expect(videoRoom.sharedSfuConfig.serverUrl).toEqual('wss://livekit.example.com');
      expect(videoRoom.sharedSfuConfig.roomName).toEqual('team-room');
      done();
    });
  });

  it('switches desired mode to sfu when four participants are active and config exists', () => {
    videoRoom.joined = true;
    videoRoom.videoParticipants = {
      'peer-a': { joined: true, updatedAt: 1 },
      'peer-b': { joined: true, updatedAt: 1 },
      'peer-c': { joined: true, updatedAt: 1 },
      'peer-d': { joined: true, updatedAt: 1 }
    };
    videoRoom.sharedSfuConfig = {
      provider: 'livekit',
      serverUrl: 'wss://livekit.example.com',
      apiKey: 'key-123',
      apiSecret: 'secret-456',
      roomName: 'team-room',
      providedBy: 'peer-b',
      updatedAt: Date.now()
    };

    expect(videoRoom.getDesiredMode()).toEqual('sfu');
  });

  it('imports video sync state from a newly connected peer', () => {
    videoRoom.importSyncState({
      participants: [
        { peerId: 'peer-b', joined: true, updatedAt: 100 },
        { peerId: 'peer-c', joined: true, updatedAt: 101 }
      ],
      sfuConfig: {
        serverUrl: 'wss://livekit.example.com',
        apiKey: 'key-123',
        apiSecret: 'secret-456',
        roomName: 'team-room',
        providedBy: 'peer-b',
        updatedAt: 102
      }
    });

    expect(videoRoom.videoParticipants['peer-b'].joined).toBe(true);
    expect(videoRoom.videoParticipants['peer-c'].joined).toBe(true);
    expect(videoRoom.sharedSfuConfig.roomName).toEqual('team-room');
  });

  it('shows a switching prompt until the sfu migration completes', done => {
    videoRoom.joined = true;
    videoRoom.mode = 'mesh';
    videoRoom.videoParticipants = {
      'peer-a': { joined: true, updatedAt: 1 },
      'peer-b': { joined: true, updatedAt: 1 },
      'peer-c': { joined: true, updatedAt: 1 },
      'peer-d': { joined: true, updatedAt: 1 }
    };
    videoRoom.sharedSfuConfig = {
      provider: 'livekit',
      serverUrl: 'wss://livekit.example.com',
      apiKey: 'key-123',
      apiSecret: 'secret-456',
      roomName: 'team-room',
      providedBy: 'peer-b',
      updatedAt: Date.now()
    };

    spyOn(videoRoom, 'leaveMeshMode');
    spyOn(videoRoom, 'enterSfuMode').and.callFake(() => {
      expect(doc.querySelector('.mode-switch-overlay').classList.contains('hide')).toBe(false);
      expect(doc.querySelector('.mode-switch-message').textContent).toContain('Switching');
      return Promise.resolve();
    });

    videoRoom.reconcileVideoMode().then(() => {
      expect(videoRoom.leaveMeshMode).toHaveBeenCalled();
      expect(doc.querySelector('.mode-switch-overlay').classList.contains('hide')).toBe(true);
      done();
    });
  });

  it('reacquires local media when falling back from sfu to mesh with a stale video track', done => {
    const staleVideoTrack = {
      readyState: 'ended',
      enabled: true,
      stop: jasmine.createSpy('stop stale video')
    };
    const staleAudioTrack = {
      readyState: 'live',
      enabled: true,
      stop: jasmine.createSpy('stop stale audio')
    };
    const staleStream = {
      active: true,
      getVideoTracks: () => [staleVideoTrack],
      getAudioTracks: () => [staleAudioTrack],
      getTracks: () => [staleVideoTrack, staleAudioTrack]
    };
    const freshVideoTrack = {
      readyState: 'live',
      enabled: true,
      stop: jasmine.createSpy('stop fresh video')
    };
    const freshAudioTrack = {
      readyState: 'live',
      enabled: true,
      stop: jasmine.createSpy('stop fresh audio')
    };
    const freshStream = {
      active: true,
      getVideoTracks: () => [freshVideoTrack],
      getAudioTracks: () => [freshAudioTrack],
      getTracks: () => [freshVideoTrack, freshAudioTrack]
    };
    const getUserMedia = jasmine.createSpy('getUserMedia').and.returnValue(Promise.resolve(freshStream));

    global.navigator.mediaDevices = {
      getUserMedia: getUserMedia
    };

    videoRoom.joined = true;
    videoRoom.mode = 'sfu';
    videoRoom.localStream = staleStream;
    controller.localMediaStream = staleStream;
    videoRoom.videoParticipants = {
      'peer-a': { joined: true, updatedAt: 1 },
      'peer-b': { joined: true, updatedAt: 1 },
      'peer-c': { joined: true, updatedAt: 1 }
    };

    spyOn(videoRoom, 'attachStreamToTile');
    spyOn(videoRoom, 'showModal');
    spyOn(videoRoom, 'reconcileMeshCalls');

    videoRoom.reconcileVideoMode().then(() => {
      expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
      expect(staleVideoTrack.stop).toHaveBeenCalled();
      expect(staleAudioTrack.stop).toHaveBeenCalled();
      expect(videoRoom.localStream).toBe(freshStream);
      expect(controller.localMediaStream).toBe(freshStream);
      expect(videoRoom.mode).toEqual('mesh');
      expect(videoRoom.reconcileMeshCalls).toHaveBeenCalled();
      done();
    }).catch(done.fail);
  });

  it('refreshes local media when falling back from sfu to mesh even if tracks still report live', done => {
    const liveVideoTrack = {
      readyState: 'live',
      enabled: true,
      stop: jasmine.createSpy('stop existing video')
    };
    const liveAudioTrack = {
      readyState: 'live',
      enabled: true,
      stop: jasmine.createSpy('stop existing audio')
    };
    const existingStream = {
      active: true,
      getVideoTracks: () => [liveVideoTrack],
      getAudioTracks: () => [liveAudioTrack],
      getTracks: () => [liveVideoTrack, liveAudioTrack]
    };
    const freshVideoTrack = {
      readyState: 'live',
      enabled: true,
      stop: jasmine.createSpy('stop refreshed video')
    };
    const freshAudioTrack = {
      readyState: 'live',
      enabled: true,
      stop: jasmine.createSpy('stop refreshed audio')
    };
    const refreshedStream = {
      active: true,
      getVideoTracks: () => [freshVideoTrack],
      getAudioTracks: () => [freshAudioTrack],
      getTracks: () => [freshVideoTrack, freshAudioTrack]
    };
    const getUserMedia = jasmine.createSpy('getUserMedia').and.returnValue(Promise.resolve(refreshedStream));

    global.navigator.mediaDevices = {
      getUserMedia: getUserMedia
    };

    videoRoom.joined = true;
    videoRoom.mode = 'sfu';
    videoRoom.localStream = existingStream;
    controller.localMediaStream = existingStream;
    videoRoom.videoParticipants = {
      'peer-a': { joined: true, updatedAt: 1 },
      'peer-b': { joined: true, updatedAt: 1 },
      'peer-c': { joined: true, updatedAt: 1 }
    };

    spyOn(videoRoom, 'showModal');
    spyOn(videoRoom, 'attachStreamToTile');
    spyOn(videoRoom, 'reconcileMeshCalls');

    videoRoom.reconcileVideoMode().then(() => {
      expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
      expect(liveVideoTrack.stop).toHaveBeenCalled();
      expect(liveAudioTrack.stop).toHaveBeenCalled();
      expect(videoRoom.localStream).toBe(refreshedStream);
      expect(controller.localMediaStream).toBe(refreshedStream);
      expect(videoRoom.mode).toEqual('mesh');
      done();
    }).catch(done.fail);
  });

  it('does not let a stale mesh call close its replacement call', () => {
    const oldHandlers = {};
    const newHandlers = {};
    const oldCall = {
      peer: 'peer-b',
      on: (eventName, handler) => { oldHandlers[eventName] = handler; },
      close: jasmine.createSpy('close old call')
    };
    const newCall = {
      peer: 'peer-b',
      on: (eventName, handler) => { newHandlers[eventName] = handler; },
      close: jasmine.createSpy('close new call')
    };

    videoRoom.registerMeshCall('peer-b', oldCall);
    videoRoom.registerMeshCall('peer-b', newCall);

    expect(oldCall.close).toHaveBeenCalled();
    expect(videoRoom.meshCalls['peer-b']).toBe(newCall);

    oldHandlers.close();

    expect(videoRoom.meshCalls['peer-b']).toBe(newCall);
    expect(newCall.close).not.toHaveBeenCalled();
  });
});
