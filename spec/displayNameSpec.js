import { JSDOM } from 'jsdom';
import Controller from '../lib/controller';

describe('Display names', () => {
  let dom, win, doc, broadcast, editor, controller;

  beforeEach(() => {
    dom = new JSDOM(`<!DOCTYPE html>
      <div id="conclave"></div>
      <input id="displayNameInput" />
      <button id="saveDisplayNameBtn"></button>
      <span class="display-name-status"></span>
      <input id="myLinkInput" />
      <button class="copy-btn"></button>
      <input id="peerIdInput" />
      <button id="connectBtn"></button>
      <span class="connect-status"></span>
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
      <ul id="peerId"></ul>
      <div class="video-modal">
        <div class="video-bar">
          <i class="minimize"></i>
          <i class="exit"></i>
        </div>
        <div class="video-stage"></div>
        <div class="mode-switch-overlay hide">
          <p class="mode-switch-title"></p>
          <p class="mode-switch-message"></p>
        </div>
      </div>` , { url: 'https://example.test' });

    win = dom.window;
    doc = win.document;

    broadcast = {
      peer: {
        id: 'peer-a',
        on: function() {},
        connect: function() {
          return {
            on: function() {},
            send: function() {}
          };
        }
      },
      bindServerEvents: function() {},
      connectToTarget: function() {},
      connectToNewTarget: function() {},
      send: function() {},
      addToNetwork: function() {},
      removeFromNetwork: function() {},
      requestConnection: function() {},
      addToOutConns: function() {},
      broadcastControlMessage: function() {},
      inConns: [],
      outConns: []
    };

    editor = {
      bindChangeEvent: function() {},
      updateView: function() {},
      onDownload: function() {},
      replaceText: function() {},
      insertText: function() {},
      deleteText: function() {},
      removeCursor: function() {},
      bindButtons: function() {}
    };

    controller = new Controller('peer-a', 'https://example.test', broadcast.peer, broadcast, editor, doc, win);
    controller.addToNetwork('peer-a', controller.siteId, controller.getSelfDisplayName(), doc, false);
  });

  it('broadcasts a custom display name and updates the local badge', () => {
    spyOn(broadcast, 'broadcastControlMessage');

    controller.updateOwnDisplayName('Alice', doc);

    expect(doc.querySelector('.self-peer-entry .peer-name').textContent).toEqual('Alice');
    expect(doc.querySelector('#displayNameInput').value).toEqual('Alice');
    expect(broadcast.broadcastControlMessage).toHaveBeenCalledWith(jasmine.objectContaining({
      type: 'peer-name',
      name: 'Alice',
      peerId: 'peer-a'
    }));
  });

  it('updates remote peer names in the list and active video tiles', () => {
    controller.addToNetwork('peer-b', 'site-b', 'Bravo', doc, false);
    controller.videoRoom.ensureTile('peer-b', 'Bravo');

    controller.handlePeerNameMessage({
      peerId: 'peer-b',
      siteId: 'site-b',
      name: 'Charlie'
    }, doc);

    expect(controller.network.find(obj => obj.siteId === 'site-b').name).toEqual('Charlie');
    expect(doc.querySelector('#peer-b .peer-name').textContent).toEqual('Charlie');
    expect(doc.querySelector('[data-video-peer="peer-b"] .video-label').textContent).toEqual('Charlie');
  });
});
