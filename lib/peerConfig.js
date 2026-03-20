// PeerJS Server Configuration
// You can easily switch between different PeerJS servers here

// Option 1: PeerJS Official Public Server (New Version)
const PEERJS_PUBLIC_SERVER = {
  host: '0.peerjs.com',
  port: 443,
  path: '/',
  secure: true,
  debug: 3,
  config: {
    'iceServers': [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
};

// Option 2: Self-hosted PeerServer (Need to run peerjs-server first)
// Install: npm install -g peer
// Run: peerjs --port 9000
const CUSTOM_LOCAL_SERVER = {
  host: 'vcm-52626.vm.duke.edu',  // Use current hostname
  port: 9000,
  path: '/',
  secure: false,
  debug: 3,
  config: {
    'iceServers': [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  }
};

// Option 3: Cloud Self-hosted PeerServer (Replace with your own server address)
const CUSTOM_CLOUD_SERVER = {
  host: 'your-server.com',  // Replace with your server address
  port: 443,
  path: '/myapp',
  secure: true,
  debug: 3,
  config: {
    'iceServers': [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
};

// Option 4: Minimal Configuration (Let PeerJS choose automatically)
const AUTO_CONFIG = {
  debug: 3
};

// Export current configuration
// Just modify this line to switch servers
export default CUSTOM_LOCAL_SERVER;

// To switch to other servers, uncomment the corresponding lines below:
// export default CUSTOM_LOCAL_SERVER;
// export default CUSTOM_CLOUD_SERVER;
// export default AUTO_CONFIG;
