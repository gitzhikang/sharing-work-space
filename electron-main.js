const { app, BrowserWindow } = require('electron');
const path = require('path');
const express = require('express');
const peer = require('peer');

let mainWindow;
let expressApp;
let server;

function createServer() {
  // Create Express app
  expressApp = express();

  expressApp.use(express.static('public'));
  expressApp.set('views', path.join(__dirname, 'views'));
  expressApp.set('view engine', 'pug');

  expressApp.get('/', function (req, res) {
    res.render('index', { title: 'Collaborative Editor' });
  });

  expressApp.get('/about', function (req, res) {
    res.render('about', { title: 'About' });
  });

  expressApp.get('/bots', function (req, res) {
    res.render('bots', { title: 'Talk to Bots' });
  });

  expressApp.get('/idLength', function (req, res) {
    res.render('idGraph');
  });

  expressApp.get('/opTime', function (req, res) {
    res.render('timeGraph');
  });

  expressApp.get('/latency', function (req, res) {
    res.render('latencyBench', { title: 'PeerJS/WebRTC Latency Benchmark' });
  });

  expressApp.get('/arraysGraph', function (req, res) {
    res.render('arraysGraph');
  });

  // Start local server
  server = expressApp.listen(0, 'localhost', () => {
    const port = server.address().port;
    console.log(`Local server running on http://localhost:${port}`);

    // Setup PeerJS server
    expressApp.use('/peerjs', peer.ExpressPeerServer(server, {
      debug: true
    }));

    // Create window after server starts
    createWindow(port);
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      // Allow access to camera and microphone
      webSecurity: true,
    },
    icon: path.join(__dirname, 'public/assets/img/favicon.ico')
  });

  // Load local server
  mainWindow.loadURL(`http://localhost:${port}`);

  // Open DevTools in development mode
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle camera/microphone permission requests
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'mediaKeySystem', 'geolocation', 'notifications', 'midi', 'midiSysex', 'pointerLock', 'fullscreen'];

    if (allowedPermissions.includes(permission)) {
      // Automatically allow media device access
      callback(true);
    } else {
      callback(false);
    }
  });

  // Handle permission checks
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (permission === 'media') {
      return true;
    }
    return false;
  });

  // Set device permission handler
  mainWindow.webContents.session.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'videoinput' || details.deviceType === 'audioinput') {
      return true;
    }
    return false;
  });
}

app.on('ready', createServer);

app.on('window-all-closed', () => {
  if (server) {
    server.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createServer();
  }
});

// Close server before app quits
app.on('before-quit', () => {
  if (server) {
    server.close();
  }
});
