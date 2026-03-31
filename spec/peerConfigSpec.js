import { JSDOM } from 'jsdom';
import {
  CUSTOM_PEERJS_STORAGE_KEY,
  buildPeerServerConfig,
  getStoredCustomPeerServerUrl,
  storeCustomPeerServerUrl
} from '../lib/peerConfig';

describe('peerConfig helpers', () => {
  describe('buildPeerServerConfig', () => {
    it('builds a secure config from a full https url', () => {
      const config = buildPeerServerConfig('https://peer.example.com:9443/myapp');

      expect(config.host).toEqual('peer.example.com');
      expect(config.port).toEqual(9443);
      expect(config.path).toEqual('/myapp');
      expect(config.secure).toBeTruthy();
      expect(config.debug).toEqual(3);
      expect(config.config.iceServers.length).toEqual(2);
    });

    it('fills in the default http port and root path', () => {
      const config = buildPeerServerConfig('http://localhost');

      expect(config.host).toEqual('localhost');
      expect(config.port).toEqual(80);
      expect(config.path).toEqual('/');
      expect(config.secure).toBeFalsy();
    });

    it('rejects malformed values', () => {
      expect(() => buildPeerServerConfig('peer.example.com:9000')).toThrowError();
    });
  });

  describe('custom server storage', () => {
    it('stores and loads the last custom peer server url', () => {
      const win = new JSDOM('', { url: 'https://localhost:3000' }).window;

      storeCustomPeerServerUrl('http://localhost:9000/', win);

      expect(win.localStorage.getItem(CUSTOM_PEERJS_STORAGE_KEY)).toEqual('http://localhost:9000/');
      expect(getStoredCustomPeerServerUrl(win)).toEqual('http://localhost:9000/');
    });
  });
});
