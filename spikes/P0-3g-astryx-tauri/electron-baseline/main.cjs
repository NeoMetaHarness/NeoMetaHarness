// Minimal Electron shell around the SAME dist/ as the Tauri app, for an apples-to-apples RAM/startup baseline.
const { app, BrowserWindow, protocol, net } = require('electron')
const path = require('node:path'), { pathToFileURL } = require('node:url')
const DIST = path.resolve(__dirname, '../dist')
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
app.whenReady().then(() => {
  protocol.handle('app', req => {
    const p = new URL(req.url).pathname
    return net.fetch(pathToFileURL(path.join(DIST, p === '/' ? 'index.html' : p)).toString())
  })
  new BrowserWindow({ width: 1280, height: 860, title: 'Neo (Electron baseline)' }).loadURL('app://neo/')
})
app.on('window-all-closed', () => app.quit())
