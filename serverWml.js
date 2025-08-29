const express = require("express")
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, 
        downloadMediaMessage, getContentType, extractMessageContent, delay } = require("@whiskeysockets/baileys")
const fs = require("fs")
const path = require("path")
const axios = require("axios")
const qrcode = require('qrcode-terminal')
const QRCode = require('qrcode')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const winston = require('winston')
const { enhancedInitialSync } = require("./loadChatUtils")
const PersistentStorage = require("./persistentStorage")


const app = express()
const port = process.env.PORT || 3000
const isDev = process.env.NODE_ENV !== 'production'
let sock = null 
// Production middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for WML compatibility
  frameguard: { action: 'deny' }
}))

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 1000 : 100 // requests per window
})
app.use('/api', limiter)

// Logging
const logger = winston.createLogger({
  level: isDev ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'app.log' })
  ]
})

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// Storage with better persistence
const storage = new PersistentStorage('./data')
const persistentData = storage.loadAllData()

let messageStore = persistentData.messages
let contactStore = persistentData.contacts  
let chatStore = persistentData.chats
let connectionState = 'disconnected'
let isFullySynced = persistentData.meta.isFullySynced
let syncAttempts = persistentData.meta.syncAttempts
// WML Constants
const WML_DTD = '<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.3//EN" "http://www.wapforum.org/DTD/wml13.dtd">'
const WMLSCRIPT_DTD = '<!DOCTYPE wmls PUBLIC "-//WAPFORUM//DTD WMLScript 1.3//EN" "http://www.wapforum.org/DTD/wmls13.dtd">'

// WML Helper Functions
function esc(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' 
  }[c]))
}

function saveContacts() {
  storage.queueSave('contacts', contactStore)
}

function saveChats() {
  storage.queueSave('chats', chatStore)
}

function saveMessages() {
  storage.queueSave('messages', messageStore)
}

function saveMeta() {
  const meta = {
    isFullySynced,
    syncAttempts,
    lastSync: new Date().toISOString(),
    contactsCount: contactStore.size,
    chatsCount: chatStore.size,
    messagesCount: messageStore.size
  }
  storage.queueSave('meta', meta)
}

function saveAll() {
  saveContacts()
  saveChats() 
  saveMessages()
  saveMeta()
}

function wmlDoc(cards, scripts = '') {
  const head = scripts ? `<head><meta http-equiv="Cache-Control" content="max-age=0"/>${scripts}</head>` : 
                         '<head><meta http-equiv="Cache-Control" content="max-age=0"/></head>'
  return `<?xml version="1.0" encoding="UTF-8"?>\n${WML_DTD}\n<wml>${head}${cards}</wml>`
}

function sendWml(res, cards, scripts = '') {
  res.setHeader('Content-Type', 'text/vnd.wap.wml; charset=UTF-8')
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.setHeader('Accept-Ranges', 'none')
  res.send(wmlDoc(cards, scripts))
}

function card(id, title, inner, ontimer = null) {
  const timerAttr = ontimer ? ` ontimer="${ontimer}"` : ''
  return `<card id="${esc(id)}" title="${esc(title)}"${timerAttr}>
   
    ${inner}
  </card>`
}

function truncate(s = '', max = 64) {
  const str = String(s)
  return str.length > max ? str.slice(0, max - 1) + '…' : str
}

function jidFriendly(jid = '') {
  if (!jid) return ''
  if (jid.endsWith('@s.whatsapp.net')) return jid.replace('@s.whatsapp.net', '')
  if (jid.endsWith('@g.us')) return `Group ${jid.slice(0, -5)}`
  return jid
}

function parseList(str = '') {
  return String(str).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
}

function formatJid(raw = '') {
  const s = String(raw).trim()
  if (!s) return s
  return s.includes('@') ? s : `${s}@s.whatsapp.net`
}

function ensureGroupJid(raw = '') {
  const s = String(raw).trim()
  if (!s) return s
  return s.endsWith('@g.us') ? s : `${s}@g.us`
}

function messageText(msg) {
  try {
    const c = extractMessageContent(msg?.message)
    if (!c) return '[unsupported]'
    if (c.conversation) return c.conversation
    if (c.extendedTextMessage?.text) return c.extendedTextMessage.text
    if (c.imageMessage?.caption) return `[IMG] ${c.imageMessage.caption || ''}`
    if (c.videoMessage?.caption) return `[VID] ${c.videoMessage.caption || ''}`
    if (c.audioMessage) return '[AUDIO]'
    if (c.documentMessage) return `[DOC] ${c.documentMessage.fileName || ''}`
    if (c.stickerMessage) return '[STICKER]'
    const type = getContentType(msg?.message) || 'unknown'
    return `[${type.toUpperCase()}]`
  } catch {
    return '[unknown]'
  }
}

function resultCard(title, lines = [], backHref = '/wml/home.wml', autoRefresh = true) {
  const refreshTimer = autoRefresh ? '' : ''
  const onTimer = autoRefresh ? ` ontimer="${backHref}"` : ''
  
  const body = `
    ${refreshTimer}
    <p><b>${esc(title)}</b></p>
    ${lines.map(l => `<p>${esc(l)}</p>`).join('')}
    <p>
      <a href="${backHref}" accesskey="0">[0] Back</a> 
      <a href="/wml/home.wml" accesskey="9">[9] Home</a>
    </p>
    <do type="accept" label="OK">
      <go href="${backHref}"/>
    </do>
    <do type="options" label="Menu">
      <go href="/wml/home.wml"/>
    </do>
  `
  return `<card id="result" title="${esc(title)}"${onTimer}>${body}</card>`
}

function navigationBar() {
  return `
    <p>
      <a href="/wml/home.wml" accesskey="1">[1] Home</a> 
      <a href="/wml/chats.wml" accesskey="2">[2] Chats</a> 
      <a href="/wml/contacts.wml" accesskey="3">[3] Contacts</a> 
      <a href="/wml/send-menu.wml" accesskey="4">[4] Send</a>
    </p>
  `
}

function searchBox(action, placeholder = "Search...") {
  return `
    <p>
      <input name="q" title="${esc(placeholder)}" size="20" maxlength="50"/>
      <do type="accept" label="Search">
        <go href="${action}" method="get">
          <postfield name="q" value="$(q)"/>
        </go>
      </do>
    </p>
  `
}

// WMLScript functions
function wmlScript(name, functions) {
  return `<script src="/wmlscript/${name}.wmls" type="text/vnd.wap.wmlscriptc"/>`
}

// WMLScript files endpoint
app.get('/wmlscript/:filename', (req, res) => {
  const { filename } = req.params
  let script = ''
  
  res.setHeader('Content-Type', 'text/vnd.wap.wmlscript')
  res.setHeader('Cache-Control', 'max-age=3600')
  
  switch(filename) {
    case 'utils.wmls':
      script = `
extern function refresh();
extern function confirmAction(message);
extern function showAlert(text);

function refresh() {
  WMLBrowser.refresh();
}

function confirmAction(message) {
  var result = Dialogs.confirm(message, "Confirm", "Yes", "No");
  return result;
}

function showAlert(text) {
  Dialogs.alert(text);
}
`
      break
    case 'wtai.wmls':
      script = `
extern function makeCall(number);
extern function sendSMS(number, message);
extern function addContact(name, number);

function makeCall(number) {
  WTAVoice.setup("wtai://wp/mc;" + number, "");
}

function sendSMS(number, message) {
  WTASMS.send("wtai://wp/ms;" + number + ";" + message, "");
}

function addContact(name, number) {
  WTAPhoneBook.write("wtai://wp/ap;" + name + ";" + number, "");
}
`
      break
    default:
      return res.status(404).send('Script not found')
  }
  
  res.send(script)
})

// Enhanced Home page with WMLScript integration
app.get(['/wml', '/wml/home.wml'], (req, res) => {
  const connected = !!sock?.authState?.creds
  const scripts = `
    ${wmlScript('utils')}
    ${wmlScript('wtai')}
  `
  
  const body = `
  
    <p><b>WhatsApp API Center</b></p>
    <p>Status: ${connected ? '<b>Connected</b>' : '<em>Disconnected</em>'}  ${esc(connectionState)}</p>
    <p>Sync: ${isFullySynced ? 'Complete' : 'Pending'}  Contacts: ${contactStore.size}  Chats: ${chatStore.size}</p>
    
    ${searchBox('/wml/search.results.wml', 'Search messages...')}
    
    <p><b>Quick Actions:</b></p>
    <p>
      <a href="/wml/status.wml" accesskey="1">[1] Status</a> 
      <a href="/wml/qr.wml" accesskey="2">[2] QR Code</a> 
      <a href="/wml/me.wml" accesskey="3">[3] Profile</a><br/>
      <a href="/wml/presence.wml" accesskey="4">[4] Presence</a> 
      <a href="/wml/privacy.wml" accesskey="5">[5] Privacy</a> 
      <a href="/wml/live-status.wml" accesskey="6">[6] Live Status</a>
    </p>
    
    <p><b>Main Menu:</b></p>
    <p>
      <a href="/wml/contacts.wml?page=1&amp;limit=10" accesskey="7">[7] Contacts</a><br/>
      <a href="/wml/chats.wml?page=1&amp;limit=10" accesskey="8">[8] Chats</a><br/>
      <a href="/wml/send-menu.wml" accesskey="9">[9] Send Message</a><br/>
      <a href="/wml/groups.wml" accesskey="*">[*] Groups</a><br/>
      <a href="/wml/broadcast.wml">[#] Broadcast</a><br/>
      <a href="/wml/debug.wml">[D] Debug</a><br/>
      <a href="/wml/logout.wml" accesskey="0">[0] Logout</a><br/>
    </p>
    
    <do type="accept" label="Refresh">
      <go href="/wml/home.wml"/>
    </do>
    <do type="options" label="Status">
      <go href="/wml/status.wml"/>
    </do>
  `
  
  sendWml(res, card('home', 'WhatsApp API', body, '/wml/home.wml'), scripts)
})


app.get('/wml/chat.wml', async (req, res) => {
  const raw = req.query.jid || ''
  const jid = formatJid(raw)
  const limit = 6 // <-- fissa 6 messaggi per pagina
  const offset = Math.max(0, parseInt(req.query.offset || '0'))
  const search = (req.query.search || '').trim().toLowerCase()

  // Carica cronologia se mancante
  if ((!chatStore.get(jid) || chatStore.get(jid).length === 0) && sock) {
    try { await loadChatHistory(jid, limit * 5) } // carica più messaggi per navigazione
    catch (e) { logger.warn(`Failed to load chat history for ${jid}: ${e.message}`) }
  }

  let allMessages = (chatStore.get(jid) || []).slice()
  allMessages.sort((a, b) => Number(b.messageTimestamp) - Number(a.messageTimestamp))

  if (search) {
    allMessages = allMessages.filter(m => (messageText(m) || '').toLowerCase().includes(search))
  }

  const slice = allMessages.slice(offset, offset + limit)
  const contact = contactStore.get(jid)
  const chatName = contact?.name || contact?.notify || contact?.verifiedName || jidFriendly(jid)
  const number = jidFriendly(jid)

  // Escape sicuro e rimuove caratteri non ASCII
  const escWml = text => (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[^\x20-\x7E]/g, '?')

  let messageList
  if (slice.length === 0) {
    messageList = `<p>No messages found.</p>
      <p>
        <a href="/wml/chat.wml?jid=${encodeURIComponent(jid)}" accesskey="2">[Back]</a> |
        <a href="/wml/index.wml" accesskey="0">[Home]</a>
      </p>`
  } else {
    messageList = slice.map(m => {
      const who = m.key.fromMe ? 'Me' : chatName
      const text = truncate(messageText(m), 100)
      const ts = new Date(Number(m.messageTimestamp) * 1000).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})
      const mid = m.key.id
      return `<p><b>${escWml(who)}</b> (${ts})<br/>
        ${escWml(text)}<br/>
        <a href="/wml/msg.wml?mid=${encodeURIComponent(mid)}&amp;jid=${encodeURIComponent(jid)}">[Actions]</a>
      </p>`
    }).join('')
  }

  // Navigazione
  const olderOffset = offset + limit
  const olderLink = olderOffset < allMessages.length
    ? `<a href="/wml/chat.wml?jid=${encodeURIComponent(jid)}&amp;offset=${olderOffset}&amp;search=${encodeURIComponent(search)}" accesskey="2">[2] Older</a>` : ''
  const newerOffset = Math.max(0, offset - limit)
  const newerLink = offset > 0
    ? `<a href="/wml/chat.wml?jid=${encodeURIComponent(jid)}&amp;offset=${newerOffset}&amp;search=${encodeURIComponent(search)}" accesskey="3">[3] Newer</a>` : ''

  const body = `
    <p><b>${escWml(chatName)}</b></p>
    <p>${escWml(number)} | ${allMessages.length} messages</p>

    <!-- Search form -->
    <p>
      <form action="/wml/chat.wml" method="get">
        <input type="hidden" name="jid" value="${escWml(jid)}"/>
        <input type="text" name="search" value="${escWml(search)}" size="12"/>
        <input type="submit" value="Search"/>
      </form>
    </p>

    ${messageList}

    <p>${olderLink} ${olderLink && newerLink ? '|' : ''} ${newerLink}</p>

    <p><b>Quick Actions:</b></p>
    <p>
      <a href="/wml/send.text.wml?to=${encodeURIComponent(jid)}" accesskey="1">[1] Send Text</a> |
      <a href="wtai://wp/mc;${number}" accesskey="9">[9] Call</a> |
      <a href="/wml/index.wml" accesskey="0">[Home]</a>
    </p>

    <do type="accept" label="Send">
      <go href="/wml/send.text.wml?to=${encodeURIComponent(jid)}"/>
    </do>
    <do type="options" label="Refresh">
      <go href="/wml/chat.wml?jid=${encodeURIComponent(jid)}&amp;offset=${offset}&amp;search=${encodeURIComponent(search)}"/>
    </do>
  `

  res.setHeader('Content-Type','text/vnd.wap.wml; charset=UTF-8')
  res.send(`<?xml version="1.0"?>
<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN" "http://www.wapforum.org/DTD/wml_1.1.xml">
<wml>
  <card id="chat" title="Chat">
    ${body}
  </card>
</wml>`)
})

// Enhanced Status page
app.get('/wml/status.wml', (req, res) => {
  const connected = !!sock?.authState?.creds
  const uptime = Math.floor(process.uptime() / 60)
  
  const body = `
   
    <p><b>System Status</b></p>
    <p>Connection: ${connected ? '<b>Active</b>' : '<em>Inactive</em>'}</p>
    <p>State: ${esc(connectionState)}</p>
    <p>QR Available: ${currentQR ? 'Yes' : 'No'}</p>
    <p>Uptime: ${uptime} minutes</p>
    
    <p><b>Data Sync:</b></p>
    <p>Status: ${isFullySynced ? '<b>Complete</b>' : '<em>In Progress</em>'}</p>
    <p>Attempts: ${syncAttempts}</p>
    <p>Contacts: ${contactStore.size}</p>
    <p>Chats: ${chatStore.size}</p>
    <p>Messages: ${messageStore.size}</p>
    
    <p><b>Sync Actions:</b></p>
    <p>
      <a href="/wml/sync.full.wml" accesskey="1">[1] Full Sync</a><br/>
      <a href="/wml/sync.contacts.wml" accesskey="2">[2] Sync Contacts</a><br/>
      <a href="/wml/sync.chats.wml" accesskey="3">[3] Sync Chats</a><br/>
    </p>
    
    ${navigationBar()}
    
    <do type="accept" label="Refresh">
      <go href="/wml/status.wml"/>
    </do>
  `
  
  sendWml(res, card('status', 'Status', body, '/wml/status.wml'))
})

// Enhanced QR Code page
app.get('/wml/qr.wml', (req, res) => {
  const body = currentQR
    ? `
    
      <p><b>QR Code Available</b></p>
      <p>Scan with WhatsApp:</p>
      <p><img src="/api/qr/image?format=wbmp" alt="QR Code" localscr="qr.wbmp"/></p>
      <p><small>Auto-refreshes every 30 seconds</small></p>
      
      <p><b>QR Formats:</b></p>
  <p>
  <a href="/api/qr/image?format=png">[PNG]</a> 
  <a href="/api/qr/text">[Text]</a> |
  <a href="/api/qr/image?format=wbmp">[WBMP]</a> 
  <a href="/api/qr/wml-wbmp">[WML+WBMP]</a>
</p>
    `
    : `
   
      <p><b>QR Code Not Available</b></p>
      <p>Status: ${esc(connectionState)}</p>
      <p>Please wait or check connection...</p>
    `

  const body_full = `
    ${body}
    ${navigationBar()}
    <do type="accept" label="Refresh">
      <go href="/wml/qr.wml"/>
    </do>
  `
  
  sendWml(res, card('qr', 'QR Code', body_full, '/wml/qr.wml'))
})


app.get("/api/qr/wml-wbmp", (req, res) => {
    if (!currentQR) {
        res.set("Content-Type", "text/vnd.wap.wml");
        return res.send(`<?xml version="1.0"?>
<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN"
  "http://www.wapforum.org/DTD/wml_1.1.xml">
<wml>
  <card id="noqr" title="QR Not Available">
    <p>QR code not available</p>
  </card>
</wml>`);
    }

    // Restituisce una WML page che richiama l'immagine WBMP
    res.set("Content-Type", "text/vnd.wap.wml");
    res.send(`<?xml version="1.0"?>
<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN"
  "http://www.wapforum.org/DTD/wml_1.1.xml">
<wml>
  <card id="qr" title="WhatsApp QR">
    <p>Scansiona il QR:</p>
    <p><img src="/api/qr/image?format=wbmp" alt="QR Code"/></p>
  </card>
</wml>`);
});


// Enhanced Contacts with search and pagination
app.get('/wml/contacts.wml', (req, res) => {
  const userAgent = req.headers['user-agent'] || ''
  const isOldNokia = /Nokia|Series40|MAUI|UP\.Browser/i.test(userAgent)
  
  const page = Math.max(1, parseInt(req.query.page || '1'))
  
  // Adatta il limite in base al dispositivo
  let limit
  if (isOldNokia) {
    limit = 3 // Nokia vecchi: massimo 3 contatti per pagina
  } else {
    limit = Math.max(1, Math.min(20, parseInt(req.query.limit || '10')))
  }
  
  const search = req.query.q || ''
  
  let contacts = Array.from(contactStore.values())
  
  // Limita il numero totale di contatti per dispositivi Nokia vecchi
  if (isOldNokia) {
    contacts = contacts.slice(0, 30) // Massimo 30 contatti totali
  }
  
  // Apply search filter
  if (search) {
    const searchLower = search.toLowerCase()
    contacts = contacts.filter(c => {
      const name = (c.name || c.notify || c.verifiedName || '').toLowerCase()
      const number = c.id.replace('@s.whatsapp.net', '')
      return name.includes(searchLower) || number.includes(searchLower)
    })
  }
  
  const total = contacts.length
  const start = (page - 1) * limit
  const items = contacts.slice(start, start + limit)

  if (isOldNokia) {
    // Versione semplificata per Nokia vecchi
    const searchForm = search ? 
      `<p>Search: ${esc(search)} (${total})</p>` :
      `<p>Contacts (${total})</p>`

    const list = items.map((c, idx) => {
      const name = c.name || c.notify || c.verifiedName || 'Unknown'
      const jid = c.id
      const number = jidFriendly(jid)
      
      // Tronca i nomi lunghi per i Nokia vecchi
      const shortName = name.length > 15 ? name.substring(0, 12) + '...' : name
      const shortNumber = number.length > 12 ? number.substring(0, 10) + '..' : number
      
      return `<p>${start + idx + 1}. ${esc(shortName)}<br/>${esc(shortNumber)}<br/>
<a href="/wml/chat.wml?jid=${encodeURIComponent(jid)}">Chat</a> 
<a href="wtai://wp/mc;${number}">Call</a></p>`
    }).join('') || '<p>No contacts</p>'

    // Navigazione semplice
    const prevPage = page > 1 ? 
      `<p><a href="/wml/contacts.wml?page=${page - 1}" accesskey="2">2-Prev</a></p>` : ''
    const nextPage = start + limit < total ? 
      `<p><a href="/wml/contacts.wml?page=${page + 1}" accesskey="3">3-Next</a></p>` : ''

    const body = `
      ${searchForm}
      <p>Page ${page}/${Math.ceil(total/limit) || 1}</p>
      ${list}
      ${prevPage}
      ${nextPage}
      <p><a href="/wml/home.wml" accesskey="0">0-Home</a></p>
    `
    
    // Usa DOCTYPE WML 1.1 per compatibilità
    const legacyCard = `<card id="contacts" title="Contacts">${body}</card>`
    const legacyDoc = `<?xml version="1.0"?>
<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN" "http://www.wapforum.org/DTD/wml_1.1.xml">
<wml>
<head><meta http-equiv="Cache-Control" content="max-age=0"/></head>
${legacyCard}
</wml>`
    
    res.setHeader('Content-Type', 'text/vnd.wap.wml; charset=ISO-8859-1')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(legacyDoc)
    
  } else {
    // Versione completa per dispositivi moderni
    const searchForm = search ? 
      `<p><b>Search Results for:</b> ${esc(search)} (${total} found)</p>` :
      `<p><b>All Contacts</b> (${total} total)</p>`

    const list = items.map((c, idx) => {
      const name = c.name || c.notify || c.verifiedName || 'Unknown'
      const jid = c.id
      const number = jidFriendly(jid)
      return `<p><b>${start + idx + 1}.</b> ${esc(name)}<br/>
        <small>${esc(number)}</small><br/>
        <a href="/wml/contact.wml?jid=${encodeURIComponent(jid)}">[View]</a> |
        <a href="/wml/chat.wml?jid=${encodeURIComponent(jid)}&amp;limit=15">[Chat]</a> |
        <a href="wtai://wp/mc;${number}">[Call]</a> |
        <a href="wtai://wp/ms;${number};">[SMS]</a><br/>
      </p>`
    }).join('') || '<p>No contacts found.</p>'

    // Pagination
    const prevPage = page > 1 ? `<a href="/wml/contacts.wml?page=${page - 1}&amp;limit=${limit}&amp;q=${encodeURIComponent(search)}" accesskey="2">[2] Prev</a>` : ''
    const nextPage = start + limit < total ? `<a href="/wml/contacts.wml?page=${page + 1}&amp;limit=${limit}&amp;q=${encodeURIComponent(search)}" accesskey="3">[3] Next</a>` : ''
    const pagination = `<p>${prevPage} ${prevPage && nextPage ? '|' : ''} ${nextPage}</p>`

    const body = `
      <timer value="120"/>
      ${searchForm}
      
      ${searchBox('/wml/contacts.wml', 'Search contacts...')}
      
      <p><b>Page ${page}/${Math.ceil(total/limit) || 1}</b></p>
      ${list}
      ${pagination}
      
      <p>
        <a href="/wml/contacts.search.wml" accesskey="1">[1] Advanced Search</a>
        ${prevPage ? ' | ' + prevPage : ''}
        ${nextPage ? ' | ' + nextPage : ''}
      </p>
      
      ${navigationBar()}
      
      <do type="accept" label="Refresh">
        <go href="/wml/contacts.wml?page=${page}&amp;limit=${limit}&amp;q=${encodeURIComponent(search)}"/>
      </do>
    `
    
    sendWml(res, card('contacts', 'Contacts', body))
  }
})

// Enhanced Contact Detail page with WTAI integration
app.get('/wml/contact.wml', async (req, res) => {
  try {
    if (!sock) throw new Error('Not connected')
    const jid = formatJid(req.query.jid || '')
    const contact = contactStore.get(jid)
    const number = jidFriendly(jid)
    
    // Try to fetch additional info
    let status = null
    let businessProfile = null
    
    try {
      status = await sock.fetchStatus(jid)
      businessProfile = await sock.getBusinessProfile(jid)
    } catch (e) {
      // Silently fail for these optional features
    }

    const body = `
      <p><b>${esc(contact?.name || contact?.notify || contact?.verifiedName || 'Unknown Contact')}</b></p>
      <p>Number: ${esc(number)}</p>
      <p>JID: <small>${esc(jid)}</small></p>
      ${status ? `<p>Status: <em>${esc(status.status || '')}</em></p>` : ''}
      ${businessProfile ? '<p><b>[BUSINESS]</b></p>' : ''}
      
      <p><b>Quick Actions:</b></p>
      <p>
        <a href="wtai://wp/mc;${number}" accesskey="1">[1] Call</a><br/>
        <a href="wtai://wp/ms;${number};" accesskey="2">[2] SMS</a><br/>
        <a href="wtai://wp/ap;${esc(contact?.name || number)};${number}" accesskey="3">[3] Add to Phone</a><br/>
      </p>
      
      <p><b>WhatsApp Actions:</b></p>
      <p>
        <a href="/wml/chat.wml?jid=${encodeURIComponent(jid)}&amp;limit=15" accesskey="4">[4] Open Chat</a><br/>
        <a href="/wml/send.text.wml?to=${encodeURIComponent(jid)}" accesskey="5">[5] Send Message</a><br/>
        <a href="/wml/block.wml?jid=${encodeURIComponent(jid)}" accesskey="7">[7] Block</a><br/>
        <a href="/wml/unblock.wml?jid=${encodeURIComponent(jid)}" accesskey="8">[8] Unblock</a><br/>
      </p>
      
      ${navigationBar()}
      
      <do type="accept" label="Chat">
        <go href="/wml/chat.wml?jid=${encodeURIComponent(jid)}&amp;limit=15"/>
      </do>
      <do type="options" label="Call">
        <go href="wtai://wp/mc;${number}"/>
      </do>
    `
    
    sendWml(res, card('contact', 'Contact Info', body))
  } catch (e) {
    sendWml(res, resultCard('Error', [e.message || 'Failed to load contact'], '/wml/contacts.wml'))
  }
})

app.get('/wml/chat.wml', async (req, res) => {
  const raw = req.query.jid || ''
  const jid = formatJid(raw)
  const limit = 6 // <-- fissa 6 messaggi per pagina
  const offset = Math.max(0, parseInt(req.query.offset || '0'))
  const search = (req.query.search || '').trim().toLowerCase()

  // Carica cronologia se mancante
  if ((!chatStore.get(jid) || chatStore.get(jid).length === 0) && sock) {
    try { await loadChatHistory(jid, limit * 5) } // carica più messaggi per navigazione
    catch (e) { logger.warn(`Failed to load chat history for ${jid}: ${e.message}`) }
  }

  let allMessages = (chatStore.get(jid) || []).slice()
  allMessages.sort((a, b) => Number(b.messageTimestamp) - Number(a.messageTimestamp))

  if (search) {
    allMessages = allMessages.filter(m => (messageText(m) || '').toLowerCase().includes(search))
  }

  const slice = allMessages.slice(offset, offset + limit)
  const contact = contactStore.get(jid)
  const chatName = contact?.name || contact?.notify || contact?.verifiedName || jidFriendly(jid)
  const number = jidFriendly(jid)

  // Escape sicuro e rimuove caratteri non ASCII
  const escWml = text => (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[^\x20-\x7E]/g, '?')

  let messageList
  if (slice.length === 0) {
    messageList = `<p>No messages found.</p>
      <p>
        <a href="/wml/chat.wml?jid=${encodeURIComponent(jid)}" accesskey="2">[Back]</a> |
        <a href="/wml/index.wml" accesskey="0">[Home]</a>
      </p>`
  } else {
    messageList = slice.map(m => {
      const who = m.key.fromMe ? 'Me' : chatName
      const text = truncate(messageText(m), 100)
      const ts = new Date(Number(m.messageTimestamp) * 1000).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})
      const mid = m.key.id
      return `<p><b>${escWml(who)}</b> (${ts})<br/>
        ${escWml(text)}<br/>
        <a href="/wml/msg.wml?mid=${encodeURIComponent(mid)}&amp;jid=${encodeURIComponent(jid)}">[Actions]</a>
      </p>`
    }).join('')
  }

  // Navigazione
  const olderOffset = offset + limit
  const olderLink = olderOffset < allMessages.length
    ? `<a href="/wml/chat.wml?jid=${encodeURIComponent(jid)}&amp;offset=${olderOffset}&amp;search=${encodeURIComponent(search)}" accesskey="2">[2] Older</a>` : ''
  const newerOffset = Math.max(0, offset - limit)
  const newerLink = offset > 0
    ? `<a href="/wml/chat.wml?jid=${encodeURIComponent(jid)}&amp;offset=${newerOffset}&amp;search=${encodeURIComponent(search)}" accesskey="3">[3] Newer</a>` : ''

  const body = `
    <p><b>${escWml(chatName)}</b></p>
    <p>${escWml(number)} | ${allMessages.length} messages</p>

    <!-- Search form -->
    <p>
      <form action="/wml/chat.wml" method="get">
        <input type="hidden" name="jid" value="${escWml(jid)}"/>
        <input type="text" name="search" value="${escWml(search)}" size="12"/>
        <input type="submit" value="Search"/>
      </form>
    </p>

    ${messageList}

    <p>${olderLink} ${olderLink && newerLink ? '|' : ''} ${newerLink}</p>

    <p><b>Quick Actions:</b></p>
    <p>
      <a href="/wml/send.text.wml?to=${encodeURIComponent(jid)}" accesskey="1">[1] Send Text</a> |
      <a href="wtai://wp/mc;${number}" accesskey="9">[9] Call</a> |
      <a href="/wml/index.wml" accesskey="0">[Home]</a>
    </p>

    <do type="accept" label="Send">
      <go href="/wml/send.text.wml?to=${encodeURIComponent(jid)}"/>
    </do>
    <do type="options" label="Refresh">
      <go href="/wml/chat.wml?jid=${encodeURIComponent(jid)}&amp;offset=${offset}&amp;search=${encodeURIComponent(search)}"/>
    </do>
  `

  res.setHeader('Content-Type','text/vnd.wap.wml; charset=UTF-8')
  res.send(`<?xml version="1.0"?>
<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN" "http://www.wapforum.org/DTD/wml_1.1.xml">
<wml>
  <card id="chat" title="Chat">
    ${body}
  </card>
</wml>`)
})




// Enhanced Message Actions page
app.get('/wml/msg.wml', (req, res) => {
  const mid = String(req.query.mid || '')
  const jid = formatJid(req.query.jid || '')
  const msg = messageStore.get(mid)
  
  if (!msg) {
    sendWml(res, resultCard('Message', ['Message not found'], `/wml/chat.wml?jid=${encodeURIComponent(jid)}&limit=15`))
    return
  }
  
  const text = truncate(messageText(msg), 150)
  const ts = new Date(Number(msg.messageTimestamp) * 1000).toLocaleString()
  const mediaType = getContentType(msg.message)
  const hasMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(mediaType)

  const body = `
    <p><b>Message Details</b></p>
    <p>${esc(text)}</p>
    <p><small>Time: ${ts}</small></p>
    <p><small>From: ${msg.key.fromMe ? 'Me' : 'Them'}</small></p>
    ${hasMedia ? `<p><small>Type: ${mediaType}</small></p>` : ''}
    
    <p><b>Actions:</b></p>
    <p>
      <a href="/wml/msg.reply.wml?mid=${encodeURIComponent(mid)}&amp;jid=${encodeURIComponent(jid)}" accesskey="1">[1] Reply</a><br/>
      <a href="/wml/msg.react.wml?mid=${encodeURIComponent(mid)}&amp;jid=${encodeURIComponent(jid)}" accesskey="2">[2] React</a><br/>
      <a href="/wml/msg.forward.wml?mid=${encodeURIComponent(mid)}" accesskey="3">[3] Forward</a><br/>
      ${hasMedia ? `<a href="/wml/media.view.wml?mid=${encodeURIComponent(mid)}" accesskey="4">[4] View Media</a><br/>` : ''}
      <a href="/wml/msg.delete.wml?mid=${encodeURIComponent(mid)}&amp;jid=${encodeURIComponent(jid)}" accesskey="7">[7] Delete</a><br/>
      <a href="/wml/msg.read.wml?mid=${encodeURIComponent(mid)}&amp;jid=${encodeURIComponent(jid)}" accesskey="8">[8] Mark Read</a><br/>
    </p>
    
    <p><a href="/wml/chat.wml?jid=${encodeURIComponent(jid)}&amp;limit=15" accesskey="0">[0] Back to Chat</a></p>
    
    <do type="accept" label="Reply">
      <go href="/wml/msg.reply.wml?mid=${encodeURIComponent(mid)}&amp;jid=${encodeURIComponent(jid)}"/>
    </do>
  `
  
  sendWml(res, card('msg', 'Message', body))
})

// Enhanced Send Menu with quick access
app.get('/wml/send-menu.wml', (req, res) => {
  const to = esc(req.query.to || '')
  const contact = to ? contactStore.get(formatJid(to)) : null
  const contactName = contact?.name || contact?.notify || jidFriendly(to) || ''

  const body = `
    <p><b>Send Message</b></p>
    ${to ? `<p>To: <b>${esc(contactName)}</b></p>` : ''}
    
    <p>Target (number or select):</p>
    <input name="target" title="Number/JID" value="${to}" size="15"/>
    
    <p><b>Message Types:</b></p>
    <select name="msgtype" title="Type" iname="type">
      <option value="/wml/send.text.wml">Text Message</option>
      <option value="/wml/send.image.wml">Image (URL)</option>
      <option value="/wml/send.video.wml">Video (URL)</option>
      <option value="/wml/send.audio.wml">Audio (URL)</option>
      <option value="/wml/send.document.wml">Document</option>
      <option value="/wml/send.sticker.wml">Sticker</option>
      <option value="/wml/send.location.wml">Location</option>
      <option value="/wml/send.contact.wml">Contact</option>
      <option value="/wml/send.poll.wml">Poll</option>
    </select>
    
    <do type="accept" label="Continue">
      <go href="$(msgtype)">
        <postfield name="to" value="$(target)"/>
      </go>
    </do>
    
    <p><b>Quick Send:</b></p>
    <p>
      <a href="/wml/send.text.wml?to=${encodeURIComponent(to)}" accesskey="1">[1] Text</a> |
      <a href="/wml/send.image.wml?to=${encodeURIComponent(to)}" accesskey="2">[2] Image</a> |
      <a href="/wml/send.location.wml?to=${encodeURIComponent(to)}" accesskey="3">[3] Location</a>
    </p>
    
    ${navigationBar()}
    
    <do type="options" label="Recent">
      <go href="/wml/contacts.wml"/>
    </do>
  `
  
  sendWml(res, card('send-menu', 'Send Menu', body))
})

// Enhanced Send Text with templates
app.get('/wml/send.text.wml', (req, res) => {
  const to = esc(req.query.to || '')
  const template = req.query.template || ''
  
  const templates = [
    'Hello! How are you?',
    'Thanks for your message.',
    'I will call you back later.',
    'Please send me the details.',
    'Meeting confirmed for today.',
  ]

  const body = `
    <p><b>Send Text Message</b></p>
    <p>To: <input name="to" title="Recipient" value="${to}" size="15"/></p>
    
    <p>Message:</p>
    <input name="message" title="Your message" value="${esc(template)}" size="30" maxlength="1000"/>
    
    ${template ? '' : `
    <p><b>Templates:</b></p>
    <select name="tmpl" title="Quick Templates">
      ${templates.map((t, i) => `<option value="${esc(t)}">${i+1}. ${esc(truncate(t, 20))}</option>`).join('')}
    </select>
    <do type="options" label="Use">
      <refresh>
        <setvar name="message" value="$(tmpl)"/>
      </refresh>
    </do>
    `}
    
    <do type="accept" label="Send">
      <go method="post" href="/wml/send.text">
        <postfield name="to" value="$(to)"/>
        <postfield name="message" value="$(message)"/>
      </go>
    </do>
    
    <p>
      <a href="/wml/send-menu.wml?to=${encodeURIComponent(to)}" accesskey="0">[0] Back</a> |
      <a href="/wml/contacts.wml" accesskey="9">[9] Contacts</a>
    </p>
  `
  
  sendWml(res, card('send-text', 'Send Text', body))
})

// Enhanced Groups management
app.get('/wml/groups.wml', async (req, res) => {
  try {
    if (!sock) throw new Error('Not connected')
    
    const groups = await sock.groupFetchAllParticipating()
    const groupList = Object.values(groups).sort((a,b) => 
      (b?.subject || '').localeCompare(a?.subject || '')
    )

    const list = groupList.map((g, idx) => {
      const memberCount = g?.participants?.length || 0
      return `<p><b>${idx + 1}.</b> ${esc(g.subject || 'Unnamed Group')}<br/>
        <small>${memberCount} members | ${esc(g.id.slice(-8))}...</small><br/>
        <a href="/wml/group.view.wml?gid=${encodeURIComponent(g.id)}" accesskey="${Math.min(idx + 1, 9)}">[${Math.min(idx + 1, 9)}] Open</a> |
        <a href="/wml/chat.wml?jid=${encodeURIComponent(g.id)}&amp;limit=15">[Chat]</a>
      </p>`
    }).join('') || '<p>No groups found.</p>'

    const body = `
     <!-- 3 min refresh -->
      <p><b>My Groups (${groupList.length})</b></p>
      
      ${searchBox('/wml/groups.search.wml', 'Search groups...')}
      
      ${list}
      
      <p><b>Group Actions:</b></p>
      <p>
        <a href="/wml/group.create.wml" accesskey="*">[*] Create New Group</a>
      </p>
      
      ${navigationBar()}
      
      <do type="accept" label="Create">
        <go href="/wml/group.create.wml"/>
      </do>
    `
    
    sendWml(res, card('groups', 'Groups', body))
  } catch (e) {
    sendWml(res, resultCard('Error', [e.message || 'Failed to load groups'], '/wml/home.wml'))
  }
})

// Enhanced Search functionality
app.get('/wml/search.results.wml', (req, res) => {
  const q = String(req.query.q || '').trim()
  const searchType = req.query.type || 'messages'
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '20')))
  
  if (!q || q.length < 2) {
    sendWml(res, resultCard('Search Error', ['Query must be at least 2 characters'], '/wml/home.wml'))
    return
  }
  
  let results = []
  const searchLower = q.toLowerCase()
  
  if (searchType === 'messages') {
    // Search through all messages
    for (const [chatId, messages] of chatStore.entries()) {
      for (const msg of messages) {
        const content = extractMessageContent(msg.message)
        const text = content?.conversation || 
                    content?.extendedTextMessage?.text || 
                    content?.imageMessage?.caption ||
                    content?.videoMessage?.caption || ''
        
        if (text.toLowerCase().includes(searchLower)) {
          const contact = contactStore.get(chatId)
          const chatName = contact?.name || contact?.notify || jidFriendly(chatId)
          const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toLocaleString('en-GB', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
          })
          
          results.push({
            type: 'message',
            chatId,
            chatName,
            messageId: msg.key.id,
            text: truncate(text, 80),
            timestamp,
            fromMe: msg.key.fromMe
          })
          
          if (results.length >= limit) break
        }
      }
      if (results.length >= limit) break
    }
  } else if (searchType === 'contacts') {
    // Search contacts
    const contacts = Array.from(contactStore.values()).filter(c => {
      const name = (c.name || c.notify || c.verifiedName || '').toLowerCase()
      const number = c.id.replace('@s.whatsapp.net', '')
      return name.includes(searchLower) || number.includes(searchLower)
    }).slice(0, limit)
    
    results = contacts.map(c => ({
      type: 'contact',
      name: c.name || c.notify || c.verifiedName || 'Unknown',
      number: jidFriendly(c.id),
      jid: c.id
    }))
  }
  
  const resultList = results.map((r, idx) => {
    if (r.type === 'message') {
      return `<p><b>${idx + 1}.</b> ${esc(r.text)}<br/>
        <small>From: ${esc(r.chatName)} | ${r.timestamp} | ${r.fromMe ? 'Me' : 'Them'}</small><br/>
        <a href="/wml/chat.wml?jid=${encodeURIComponent(r.chatId)}&amp;limit=15">[Open Chat]</a> |
        <a href="/wml/msg.wml?mid=${encodeURIComponent(r.messageId)}&amp;jid=${encodeURIComponent(r.chatId)}">[Message]</a>
      </p>`
    } else if (r.type === 'contact') {
      return `<p><b>${idx + 1}.</b> ${esc(r.name)}<br/>
        <small>${esc(r.number)}</small><br/>
        <a href="/wml/contact.wml?jid=${encodeURIComponent(r.jid)}">[View]</a> |
        <a href="/wml/chat.wml?jid=${encodeURIComponent(r.jid)}&amp;limit=15">[Chat]</a>
      </p>`
    }
    return ''
  }).join('') || '<p>No results found.</p>'

  const body = `
    <p><b>Search Results</b></p>
    <p>Query: <b>${esc(q)}</b></p>
    <p>Type: ${esc(searchType)} | Found: ${results.length}</p>
    
    ${resultList}
    
    <p><b>Search Again:</b></p>
    <p>
      <a href="/wml/search.wml?q=${encodeURIComponent(q)}" accesskey="1">[1] New Search</a> |
      <a href="/wml/home.wml" accesskey="0">[0] Home</a>
    </p>
    
    <do type="accept" label="Home">
      <go href="/wml/home.wml"/>
    </do>
  `
  
  sendWml(res, card('search-results', 'Search Results', body))
})

// Enhanced Search form
app.get('/wml/search.wml', (req, res) => {
  const prevQuery = esc(req.query.q || '')
  
  const body = `
    <p><b>Search WhatsApp</b></p>
    
    <p>Search for:</p>
    <input name="q" title="Search query" value="${prevQuery}" size="20" maxlength="100"/>
    
    <p>Search in:</p>
    <select name="type" title="Search Type">
      <option value="messages">Messages</option>
      <option value="contacts">Contacts</option>
    </select>
    
    <p>Limit:</p>
    <select name="limit" title="Max Results">
      <option value="10">10 results</option>
      <option value="20">20 results</option>
      <option value="50">50 results</option>
    </select>
    
    <do type="accept" label="Search">
      <go href="/wml/search.results.wml" method="get">
        <postfield name="q" value="$(q)"/>
        <postfield name="type" value="$(type)"/>
        <postfield name="limit" value="$(limit)"/>
      </go>
    </do>
    
    <p><b>Quick Searches:</b></p>
    <p>
      <a href="/wml/search.results.wml?q=today&amp;type=messages" accesskey="1">[1] "today"</a><br/>
      <a href="/wml/search.results.wml?q=important&amp;type=messages" accesskey="2">[2] "important"</a><br/>
      <a href="/wml/search.results.wml?q=meeting&amp;type=messages" accesskey="3">[3] "meeting"</a><br/>
    </p>
    
    ${navigationBar()}
  `
  
  sendWml(res, card('search', 'Search', body))
})

// Auto-refresh for dynamic content
app.get('/wml/live-status.wml', (req, res) => {
  const refreshInterval = req.query.interval || '30'
  
  const body = `
   
    <p><b>Live Status Monitor</b></p>
    <p>Updates every ${refreshInterval} seconds</p>
    
    <p><b>Connection:</b> ${connectionState}</p>
    <p><b>Messages:</b> ${messageStore.size}</p>
    <p><b>Contacts:</b> ${contactStore.size}</p>
    <p><b>Chats:</b> ${chatStore.size}</p>
    <p><b>Time:</b> ${new Date().toLocaleTimeString()}</p>
    
    <p>
      <a href="/wml/live-status.wml?interval=10" accesskey="1">[1] 10s refresh</a><br/>
      <a href="/wml/live-status.wml?interval=30" accesskey="2">[2] 30s refresh</a><br/>
      <a href="/wml/live-status.wml?interval=60" accesskey="3">[3] 60s refresh</a><br/>
    </p>
    
    <p><a href="/wml/home.wml" accesskey="0">[0] Home</a></p>
    
    <do type="accept" label="Stop">
      <go href="/wml/status.wml"/>
    </do>
  `
  
  sendWml(res, card('live-status', 'Live Status', body, `/wml/live-status.wml?interval=${refreshInterval}`))
})

// Add all the existing endpoints from your original code here...
// [Previous POST handlers for send.text, send.image, etc.]

// Keep all existing POST handlers and API endpoints
app.post('/wml/send.text', async (req, res) => {
  try {
    if (!sock) throw new Error('Not connected')
    const { to, message } = req.body
    const result = await sock.sendMessage(formatJid(to), { text: message })
    sendWml(res, resultCard('Message Sent', [
      `To: ${jidFriendly(to)}`,
      `Message: ${truncate(message, 50)}`,
      `ID: ${result?.key?.id || 'Unknown'}`
    ], '/wml/send-menu.wml'))
  } catch (e) {
    sendWml(res, resultCard('Send Failed', [e.message || 'Failed to send'], '/wml/send.text.wml'))
  }
})

// Enhanced sync functions
async function loadChatHistory(jid, limit = 20000) {
  if (!sock) return
  try {
    // In production, implement proper message fetching
    logger.info(`Loading chat history for ${jid}, limit: ${limit}`)
  } catch (error) {
    logger.error(`Failed to load chat history: ${error.message}`)
  }
}

async function performInitialSync() {
  try {
    if (!sock || connectionState !== 'open') {
      logger.warn("Cannot sync: not connected")
      return
    }

    logger.info(`Starting enhanced initial sync (attempt ${syncAttempts + 1})`)
    syncAttempts++

    let successCount = 0

    // Sync contacts
    try {
      logger.info("Checking contacts...")
      if (contactStore.size === 0) {
        logger.info("Waiting for contacts via events...")
        await delay(3000)
      }
      logger.info(`Contacts in store: ${contactStore.size}`)
      successCount++
    } catch (err) {
      logger.error("Contact sync failed:", err.message)
    }

    // Sync chats
    try {
      logger.info("Fetching chats...")
      const groups = await sock.groupFetchAllParticipating()
      logger.info(`Retrieved ${Object.keys(groups).length} groups`)

      for (const chatId of Object.keys(groups)) {
        if (!chatStore.has(chatId)) {
          chatStore.set(chatId, [])
        }
      }

      if (chatStore.size === 0) {
        logger.info("Waiting for chats via events...")
        await delay(3000)
      }

      logger.info(`Chats in store: ${chatStore.size}`)
      successCount++
    } catch (err) {
      logger.error("Chat sync failed:", err.message)
    }

    // Check sync completion
    const counts = {
      contacts: contactStore.size,
      chats: chatStore.size,
      messages: messageStore.size
    }
    
    logger.info("Sync results:", counts)

    if (counts.contacts > 0 && counts.chats > 0) {
      isFullySynced = true
      logger.info("Initial sync completed successfully!")
    } else if (syncAttempts < 9999999) {
      const delayMs = syncAttempts * 5000
      logger.info(`Sync incomplete, retrying in ${delayMs/1000}s...`)
      setTimeout(performInitialSync, delayMs)
    } else {
      logger.warn("Sync attempts exhausted. Data may still load gradually.")
    }
  } catch (err) {
    logger.error("Initial sync failed:", err)
    if (syncAttempts < 999999) {
      setTimeout(performInitialSync, 5000)
    }
  }
}




// Production-ready connection with better error handling
async function connectWithBetterSync() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys')
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: true,
      markOnlineOnConnect: false,
      emitOwnEvents: true,
      getMessage: async (key) => messageStore.get(key.id) || null,
      shouldIgnoreJid: jid => false,
      shouldSyncHistoryMessage: msg => true,
      browser: ["WhatsApp WML Gateway", "Chrome", "1.0.0"],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      retryRequestDelayMs: 1000
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      connectionState = connection

      if (qr) {
        currentQR = qr
        logger.info("QR Code generated")
        if (isDev) {
          qrcode.generate(qr, { small: true })
        }
      }

      if (connection === "close") {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
        logger.info(`Connection closed. Should reconnect: ${shouldReconnect}`)
        
        if (shouldReconnect) {
          const delay = Math.min(5000 * Math.pow(2, syncAttempts), 30000) // Exponential backoff
          setTimeout(connectWithBetterSync, delay)
        } else {
          // Clear stores on logout
          contactStore.clear()
          chatStore.clear()
          messageStore.clear()
          isFullySynced = false
          syncAttempts = 0
        }
      } else if (connection === "open") {
        logger.info("WhatsApp connected successfully!")
        currentQR = null
        isFullySynced = false
        syncAttempts = 0
        
        // Start sync process
        setTimeout(enhancedInitialSync, 5000)
      }
    })

    // Enhanced event handlers
    sock.ev.on("messaging-history.set", ({ chats, contacts, messages, isLatest }) => {
      logger.info(`History batch - Chats: ${chats.length}, Contacts: ${contacts.length}, Messages: ${messages.length}`)

      for (const chat of chats) {
        if (!chatStore.has(chat.id)) {
          chatStore.set(chat.id, [])
        }
      }

      for (const contact of contacts) {
        contactStore.set(contact.id, contact)
      }

      for (const msg of messages) {
        if (msg.key?.id) {
          messageStore.set(msg.key.id, msg)
          const chatId = msg.key.remoteJid
          if (!chatStore.has(chatId)) {
            chatStore.set(chatId, [])
          }
          const chatMessages = chatStore.get(chatId)
          chatMessages.push(msg)
          
         
        }
      }

      if (isLatest) {
        logger.info("Bulk history sync complete")
        isFullySynced = true
         saveAll()
      }
    })

    // Real-time message handling
    sock.ev.on("messages.upsert", async ({ messages }) => {
      let newMessagesCount = 0 // A
      for (const msg of messages) {
          newMessagesCount++ // ADD TH
        if (msg.key?.id) {
          messageStore.set(msg.key.id, msg)
          const chatId = msg.key.remoteJid
          
          if (!chatStore.has(chatId)) {
            chatStore.set(chatId, [])
          }
          
          const chatMessages = chatStore.get(chatId)
          chatMessages.push(msg)
          
          // Keep chat history manageable
          if (chatMessages.length > 200) {
            chatMessages.shift()
          }
        }

        // Auto-respond to ping
        if (!msg.key.fromMe && msg.message?.conversation === "ping") {
          try {
            await sock.sendMessage(msg.key.remoteJid, { text: "pong" }, { quoted: msg })
          } catch (error) {
            logger.error("Failed to send pong:", error)
          }
        }
      }
       // ADD THESE LINES:
  if (newMessagesCount > 0) {
    saveMessages()
    saveChats()
  }
    })

    // Contact and chat updates
    sock.ev.on("contacts.set", ({ contacts }) => {
      logger.info(`Contacts set: ${contacts.length}`)
      for (const c of contacts) {
        contactStore.set(c.id, c)
      }
        saveContacts() // ADD THIS LINE
    })

    sock.ev.on("contacts.update", (contacts) => {
      for (const c of contacts) {
        if (c.id) contactStore.set(c.id, c)
      }
    })

    sock.ev.on("chats.set", ({ chats }) => {
      logger.info(`Chats set: ${chats.length}`)
      for (const c of chats) {
        if (!chatStore.has(c.id)) {
          chatStore.set(c.id, [])
        }
      }
    })

    sock.ev.on("chats.update", (chats) => {
      for (const c of chats) {
        if (!chatStore.has(c.id)) {
          chatStore.set(c.id, [])
        }
      }
    })

  } catch (error) {
    logger.error("Connection error:", error)
    setTimeout(connectWithBetterSync, 10000)
  }
}

connectWithBetterSync()

// Keep all existing API endpoints from the original code...
// [Include all /api/ routes here]

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal}. Shutting down gracefully...`)
  try {


       // ADD THESE LINES:
    logger.info('Saving all data before shutdown...')
    await storage.saveImmediately('contacts', contactStore)
    await storage.saveImmediately('chats', chatStore)
    await storage.saveImmediately('messages', messageStore)
    await storage.saveImmediately('meta', {
      isFullySynced,
      syncAttempts,
      lastSync: new Date().toISOString()
    })
    logger.info('Data saved successfully')

     if (typeof sock !== 'undefined' && sock) {
      logger.info('Closing WhatsApp connection...')
      await sock.end()
      logger.info('WhatsApp connection closed')
    } else {
      logger.info('No WhatsApp connection to close')
    }
    
    contactStore.clear()
    chatStore.clear()
    messageStore.clear()
    
    logger.info('Graceful shutdown completed')
    process.exit(0)
  } catch (error) {
    logger.error('Error during shutdown:', error)
    process.exit(1)
  }
}

// Signal handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2'))

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error)
  gracefulShutdown('uncaughtException')
})

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason)

  //gracefulShutdown('unhandledRejection')
})

// Start server
const server = app.listen(port, () => {
  logger.info(`WhatsApp WML Gateway started on port ${port}`)
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`)
  logger.info('WML endpoints available at /wml/')
  logger.info('API endpoints available at /api/')

  setInterval(() => {
  storage.cleanupOldMessages(messageStore, chatStore, 100)
}, 60 * 60 * 1000) // every hour

setInterval(() => {
  saveAll()
  logger.info("Periodic save completed")
}, 10 * 60 * 1000)
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${port} is already in use`)
    process.exit(1)
  } else {
    logger.error('Server error:', error)
    process.exit(1)
  }
})

// Initialize connection

app.get("/api/status", (req, res) => {
    const isConnected = !!sock?.authState?.creds
    
    res.json({
        connected: isConnected,
        status: connectionState,
        user: sock?.user || null,
        qrAvailable: !!currentQR,
        syncStatus: {
            isFullySynced,
            syncAttempts,
            contactsCount: contactStore.size,
            chatsCount: chatStore.size,
            messagesCount: messageStore.size
        },
        uptime: process.uptime(),
        recommendations: getRecommendations(isConnected)
    })
})

app.get("/api/status-detailed", async (req, res) => {
    try {
        const isConnected = !!sock?.authState?.creds
        let syncStatus = {
            contacts: contactStore.size,
            chats: chatStore.size,
            messages: messageStore.size,
            isFullySynced,
            syncAttempts
        }
        
        res.json({
            connected: isConnected,
            status: connectionState,
            user: sock?.user || null,
            qrAvailable: !!currentQR,
            syncStatus,
            stores: {
                contactStore: {
                    size: contactStore.size,
                    sample: Array.from(contactStore.entries()).slice(0, 3).map(([key, value]) => ({
                        key,
                        name: value.name || value.notify || 'Unknown',
                        hasName: !!value.name
                    }))
                },
                chatStore: {
                    size: chatStore.size,
                    sample: Array.from(chatStore.keys()).slice(0, 5)
                }
            },
            recommendations: getRecommendations(isConnected)
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

function getRecommendations(isConnected) {
    if (!isConnected) {
        return ["Please connect to WhatsApp first", "Check QR code if available"]
    }
    
    if (!isFullySynced && contactStore.size === 0 && chatStore.size === 0) {
        return [
            "Try calling POST /api/full-sync to force data loading",
            "Wait a few more seconds for WhatsApp to sync",
            "Send a test message to trigger data loading"
        ]
    }
    
    if (contactStore.size === 0) {
        return ["Call POST /api/force-sync-contacts to load contacts"]
    }
    
    if (chatStore.size === 0) {
        return ["Call POST /api/force-sync-chats to load chats"]
    }
    
    return ["All systems operational"]
}

// Force sync endpoints
app.post("/api/full-sync", async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        console.log("🔄 Starting full manual sync...")
        const results = {
            contacts: 0,
            chats: 0,
            recentChats: 0,
            errors: []
        }
        
        // Sync contacts
        try {
            console.log("📞 Attempting contact sync...")
            
            // In Baileys, contacts are populated automatically via events
            // We can't manually fetch them, so we wait for the events
            if (contactStore.size === 0) {
                console.log("📞 Waiting for contacts to sync via events...")
                await delay(3000) // Wait for events to populate
            }
            
            results.contacts = contactStore.size
            console.log(`📞 Contacts available: ${contactStore.size}`)
        } catch (error) {
            results.errors.push(`Contacts sync info: ${error.message}`)
        }
        
        // Sync chats
        try {
            const chats = await sock.groupFetchAllParticipating()
            Object.keys(chats).forEach(chatId => {
                if (!chatStore.has(chatId)) {
                    chatStore.set(chatId, [])
                }
            })
            results.chats = Object.keys(chats).length
            console.log(`💬 Manually synced ${Object.keys(chats).length} chats`)
        } catch (error) {
            results.errors.push(`Chats sync failed: ${error.message}`)
        }
        
        // Sync recent chats
        try {
            console.log("💬 Checking for additional chats...")
            
            // In Baileys, we don't have fetchChats, but we have what we got from groupFetchAllParticipating
            // Let's wait a bit more for any chat events
            await delay(2000)
            
            results.recentChats = chatStore.size - results.chats
            console.log(`💬 Additional chats found: ${results.recentChats}`)
        } catch (error) {
            results.errors.push(`Additional chats check failed: ${error.message}`)
        }
        
        // Update sync status
        if (contactStore.size > 0 || chatStore.size > 0) {
            isFullySynced = true
        }
        
        res.json({
            status: "completed",
            results,
            currentStore: {
                contacts: contactStore.size,
                chats: chatStore.size,
                messages: messageStore.size
            },
            isFullySynced
        })
        
    } catch (error) {
        console.error("❌ Full sync failed:", error)
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/force-sync-contacts", async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        console.log("🔄 Checking contact sync status...")
        
        // In Baileys, contacts are synced via events, not direct API calls
        // We can only report what we have and potentially trigger a refresh
        const initialCount = contactStore.size
        
        // Wait a bit to see if more contacts come in
        console.log("📞 Waiting for contact events...")
        await delay(3000)
        
        const finalCount = contactStore.size
        const newContacts = finalCount - initialCount
        
        console.log(`✅ Contact sync check completed. Total: ${finalCount}, New: ${newContacts}`)
        
        res.json({
            status: "success",
            message: "Contacts are synced via WhatsApp events",
            initialCount,
            finalCount,
            newContacts,
            totalInStore: contactStore.size
        })
    } catch (error) {
        console.error("❌ Contact sync check failed:", error)
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/force-sync-chats", async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        console.log("🔄 Forcing chat sync...")
        
        const initialChatCount = chatStore.size
        
        // Get participating groups (this works)
        const chats = await sock.groupFetchAllParticipating()
        
        Object.keys(chats).forEach(chatId => {
            if (!chatStore.has(chatId)) {
                chatStore.set(chatId, [])
            }
        })
        
        // Wait for any additional chat events
        console.log("💬 Waiting for additional chat events...")
        await delay(3000)
        
        const finalChatCount = chatStore.size
        const newChats = finalChatCount - initialChatCount
        
        console.log(`✅ Chat sync completed. Groups: ${Object.keys(chats).length}, Total: ${finalChatCount}`)
        
        res.json({
            status: "success",
            groupChats: Object.keys(chats).length,
            initialTotal: initialChatCount,
            finalTotal: finalChatCount,
            newChats: newChats,
            totalInStore: chatStore.size
        })
    } catch (error) {
        console.error("❌ Force sync chats failed:", error)
        res.status(500).json({ error: error.message })
    }
})

app.get("/api/debug-stores", (req, res) => {
    res.json({
        connectionState,
        isFullySynced,
        syncAttempts,
        contactStore: {
            size: contactStore.size,
            sample: Array.from(contactStore.entries()).slice(0, 5).map(([key, value]) => ({
                key,
                name: value.name || value.notify || 'Unknown',
                hasName: !!value.name,
                notify: value.notify,
                verifiedName: value.verifiedName
            }))
        },
        chatStore: {
            size: chatStore.size,
            chats: Array.from(chatStore.keys()).slice(0, 10)
        },
        messageStore: {
            size: messageStore.size,
            sample: Array.from(messageStore.keys()).slice(0, 5)
        }
    })
})

// =================== QR CODE ENDPOINTS ===================

app.get("/api/qr", (req, res) => {
    if (currentQR) {
        res.send(`
            <html><body style="text-align:center;padding:50px;font-family:Arial;">
                <h2>📱 WhatsApp QR Code</h2>
                <div style="background:white;padding:20px;border-radius:10px;display:inline-block;">
                    <img src="data:image/png;base64,${Buffer.from(currentQR).toString('base64')}" style="border:10px solid #25D366;border-radius:10px;"/>
                </div>
                <p>Scan with WhatsApp app</p>
                <p><small>Auto-refresh in 10 seconds</small></p>
                <script>setTimeout(() => location.reload(), 10000);</script>
            </body></html>
        `)
    } else {
        res.json({ 
            message: "QR not available", 
            connected: !!sock?.authState?.creds,
            status: connectionState 
        })
    }
})

app.get("/api/qr/image", async (req, res) => {
    const { format = 'png' } = req.query
    
    if (!currentQR) {
        return res.status(404).json({ 
            error: "QR code not available",
            connected: !!sock?.authState?.creds,
            status: connectionState 
        })
    }
    
    try {
        if (format.toLowerCase() === 'wbmp') {
            // Generate QR as WBMP format using qrcode library
            try {
                const qrBuffer = await QRCode.toBuffer(currentQR, {
                    type: 'png',
                    width: 256,
                    margin: 2,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    }
                })
                
                // Convert PNG to simple WBMP-like format
                // WBMP is a monochrome format, so we'll return the QR as minimal binary
                res.setHeader('Content-Type', 'image/vnd.wap.wbmp')
                res.setHeader('Content-Disposition', 'inline; filename="qr-code.wbmp"')
                res.setHeader('Cache-Control', 'no-cache')
                
                // Return the buffer (simplified WBMP representation)
                res.send(qrBuffer)
            } catch (qrError) {
                // Fallback: return raw QR string as WBMP
                res.setHeader('Content-Type', 'image/vnd.wap.wbmp')
                res.setHeader('Content-Disposition', 'inline; filename="qr-code.wbmp"')
                const qrBuffer = Buffer.from(currentQR, 'utf8')
                res.send(qrBuffer)
            }
        } else if (format.toLowerCase() === 'base64') {
            // Return as base64 JSON response
            res.json({
                qrCode: currentQR,
                format: 'base64',
                timestamp: Date.now(),
                dataUrl: `data:text/plain;base64,${Buffer.from(currentQR).toString('base64')}`
            })
        } else if (format.toLowerCase() === 'png') {
            // Generate proper PNG QR code
            try {
                const qrBuffer = await QRCode.toBuffer(currentQR, {
                    type: 'png',
                    width: 256,
                    margin: 2,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    }
                })
                
                res.setHeader('Content-Type', 'image/png')
                res.setHeader('Content-Disposition', 'inline; filename="qr-code.png"')
                res.setHeader('Cache-Control', 'no-cache')
                res.send(qrBuffer)
            } catch (qrError) {
                // Fallback to base64 if available
                res.setHeader('Content-Type', 'image/png')
                res.send(Buffer.from(currentQR, 'base64'))
            }
        } else if (format.toLowerCase() === 'svg') {
            // Generate SVG QR code
            try {
                const qrSvg = await QRCode.toString(currentQR, {
                    type: 'svg',
                    width: 256,
                    margin: 2,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    }
                })
                
                res.setHeader('Content-Type', 'image/svg+xml')
                res.setHeader('Content-Disposition', 'inline; filename="qr-code.svg"')
                res.setHeader('Cache-Control', 'no-cache')
                res.send(qrSvg)
            } catch (qrError) {
                res.status(500).json({ error: "Failed to generate SVG QR code" })
            }
        } else {
            res.status(400).json({ 
                error: "Unsupported format", 
                supportedFormats: ['png', 'svg', 'base64', 'wbmp'],
                examples: [
                    'GET /api/qr/image?format=png',
                    'GET /api/qr/image?format=svg', 
                    'GET /api/qr/image?format=wbmp',
                    'GET /api/qr/image?format=base64'
                ]
            })
        }
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/api/qr/text", (req, res) => {
    if (!currentQR) {
        res.set("Content-Type", "text/vnd.wap.wml");
        return res.send(`<?xml version="1.0"?>
<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN"
  "http://www.wapforum.org/DTD/wml_1.1.xml">
<wml>
  <card id="noqr" title="QR Not Available">
    <p>QR code not available</p>
  </card>
</wml>`);
    }

    res.set("Content-Type", "text/vnd.wap.wml");
    res.send(`<?xml version="1.0"?>
<!DOCTYPE wml PUBLIC "-//WAPFORUM//DTD WML 1.1//EN"
  "http://www.wapforum.org/DTD/wml_1.1.xml">
<wml>
  <card id="qr" title="WhatsApp QR">
    <p>Your QR string:</p>
    <p>${currentQR}</p>
  </card>
</wml>`);
});


app.post("/api/logout", async (req, res) => {
    try {
        if (sock) await sock.logout()
        if (fs.existsSync('./auth_info_baileys')) {
            fs.rmSync('./auth_info_baileys', { recursive: true })
        }
        
        // Clear stores
        contactStore.clear()
        chatStore.clear()
        messageStore.clear()
        isFullySynced = false
        syncAttempts = 0

       
        
        res.json({ status: "Logged out and data cleared" })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/api/me", async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const profilePic = await sock.profilePictureUrl(sock.user.id).catch(() => null)
        const status = await sock.fetchStatus(sock.user.id).catch(() => null)
        
        res.json({
            user: sock.user,
            profilePicture: profilePic,
            status: status?.status,
            syncStatus: {
                isFullySynced,
                contactsCount: contactStore.size,
                chatsCount: chatStore.size
            }
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/update-profile-name", async (req, res) => {
    try {
        const { name } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        await sock.updateProfileName(name)
        res.json({ status: "Profile name updated" })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/update-profile-status", async (req, res) => {
    try {
        const { status } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        await sock.updateProfileStatus(status)
        res.json({ status: "Profile status updated" })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/update-profile-picture", async (req, res) => {
    try {
        const { imageUrl } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' })
        await sock.updateProfilePicture(sock.user.id, response.data)
        res.json({ status: "Profile picture updated" })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/presence", async (req, res) => {
    try {
        const { jid, presence = 'available' } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        if (jid) {
            await sock.sendPresenceUpdate(presence, formatJid(jid))
        } else {
            await sock.sendPresenceUpdate(presence)
        }
        res.json({ status: `Presence set to ${presence}` })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// =================== ENHANCED CONTACTS ENDPOINTS ===================

app.get("/api/contacts/all", async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        // Auto-sync if no contacts and not synced yet
        if (contactStore.size === 0 && !isFullySynced) {
            console.log("📞 No contacts found, waiting for sync events...")
            // In Baileys, contacts come via events, so we just wait
            await delay(2000)
            console.log(`📞 Contacts after wait: ${contactStore.size}`)
        }
        
        const { page = 1, limit = 100, enriched = false } = req.query
        const contacts = Array.from(contactStore.values())
        
        // Pagination
        const startIndex = (parseInt(page) - 1) * parseInt(limit)
        const endIndex = startIndex + parseInt(limit)
        const paginatedContacts = contacts.slice(startIndex, endIndex)
        
        if (enriched === 'true') {
            const enrichedContacts = []
            
            for (const contact of paginatedContacts) {
                try {
                    const profilePic = await sock.profilePictureUrl(contact.id, 'image').catch(() => null)
                    const status = await sock.fetchStatus(contact.id).catch(() => null)
                    const businessProfile = await sock.getBusinessProfile(contact.id).catch(() => null)
                    
                    enrichedContacts.push({
                        id: contact.id,
                        name: contact.name || contact.notify || contact.verifiedName,
                        profilePicture: profilePic,
                        status: status?.status,
                        lastSeen: status?.setAt,
                        isMyContact: contact.name ? true : false,
                        isBusiness: !!businessProfile,
                        businessProfile: businessProfile,
                        notify: contact.notify,
                        verifiedName: contact.verifiedName
                    })
                    
                    await delay(150)
                } catch (error) {
                    enrichedContacts.push({
                        id: contact.id,
                        name: contact.name || contact.notify || contact.verifiedName,
                        error: error.message
                    })
                }
            }
            
            res.json({
                contacts: enrichedContacts,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: contacts.length,
                    totalPages: Math.ceil(contacts.length / parseInt(limit)),
                    hasNext: endIndex < contacts.length,
                    hasPrev: parseInt(page) > 1
                },
                syncInfo: { isFullySynced, syncAttempts }
            })
        } else {
            const basicContacts = paginatedContacts.map(contact => ({
                id: contact.id,
                name: contact.name || contact.notify || contact.verifiedName,
                notify: contact.notify,
                verifiedName: contact.verifiedName,
                isMyContact: contact.name ? true : false
            }))
            
            res.json({
                contacts: basicContacts,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: contacts.length,
                    totalPages: Math.ceil(contacts.length / parseInt(limit)),
                    hasNext: endIndex < contacts.length,
                    hasPrev: parseInt(page) > 1
                },
                syncInfo: { isFullySynced, syncAttempts }
            })
        }
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/api/contacts/count", (req, res) => {
    try {
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        res.json({
            totalContacts: contactStore.size,
            withNames: Array.from(contactStore.values()).filter(c => c.name).length,
            businessContacts: Array.from(contactStore.values()).filter(c => c.verifiedName).length,
            syncInfo: { isFullySynced, syncAttempts }
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/contacts/search", async (req, res) => {
    try {
        const { query, limit = 50 } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        if (!query || query.length < 2) {
            return res.status(400).json({ error: "Query must be at least 2 characters" })
        }
        
        const searchQuery = query.toLowerCase()
        const contacts = Array.from(contactStore.values())
        
        const results = contacts.filter(contact => {
            const name = (contact.name || contact.notify || contact.verifiedName || '').toLowerCase()
            const number = contact.id.replace('@s.whatsapp.net', '')
            
            return name.includes(searchQuery) || number.includes(searchQuery)
        }).slice(0, parseInt(limit))
        
        res.json({
            query: query,
            results: results.map(contact => ({
                id: contact.id,
                name: contact.name || contact.notify || contact.verifiedName,
                notify: contact.notify,
                verifiedName: contact.verifiedName,
                number: contact.id.replace('@s.whatsapp.net', ''),
                isMyContact: contact.name ? true : false
            })),
            total: results.length,
            syncInfo: { isFullySynced, syncAttempts }
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// =================== ENHANCED CHAT ENDPOINTS ===================

app.get("/api/chats/with-numbers", async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        // Auto-sync if no chats and not synced yet
        if (chatStore.size === 0 && !isFullySynced) {
            console.log("💬 No chats found, attempting auto-sync...")
            try {
                const chats = await sock.groupFetchAllParticipating()
                
                Object.keys(chats).forEach(chatId => {
                    if (!chatStore.has(chatId)) {
                        chatStore.set(chatId, [])
                    }
                })
                
                console.log(`💬 Auto-synced ${Object.keys(chats).length} group chats`)
                
                // Wait for additional chat events
                await delay(2000)
                console.log(`💬 Total chats after wait: ${chatStore.size}`)
            } catch (syncError) {
                console.log("⚠️ Auto-sync failed:", syncError.message)
            }
        }
        
        const chats = Array.from(chatStore.keys()).map(chatId => {
            const messages = chatStore.get(chatId) || []
            const lastMessage = messages[messages.length - 1]
            const contact = contactStore.get(chatId)
            
            const phoneNumber = chatId.replace('@s.whatsapp.net', '').replace('@g.us', '')
            const isGroup = chatId.endsWith('@g.us')
            
            return {
                id: chatId,
                phoneNumber: isGroup ? null : phoneNumber,
                groupId: isGroup ? phoneNumber : null,
                isGroup: isGroup,
                contact: {
                    name: contact?.name || contact?.notify || contact?.verifiedName,
                    isMyContact: contact?.name ? true : false
                },
                messageCount: messages.length,
                lastMessage: lastMessage ? {
                    id: lastMessage.key.id,
                    message: extractMessageContent(lastMessage.message),
                    timestamp: lastMessage.messageTimestamp,
                    fromMe: lastMessage.key.fromMe
                } : null
            }
        })
        
        chats.sort((a, b) => {
            const aTime = a.lastMessage?.timestamp || 0
            const bTime = b.lastMessage?.timestamp || 0
            return bTime - aTime
        })
        
        res.json({ 
            chats,
            total: chats.length,
            directChats: chats.filter(c => !c.isGroup).length,
            groupChats: chats.filter(c => c.isGroup).length,
            syncInfo: { isFullySynced, syncAttempts }
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/api/chat/by-number/:number", async (req, res) => {
    try {
        const { number } = req.params
        const { limit = 50, offset = 0 } = req.query
        
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const jid = formatJid(number)
        const messages = chatStore.get(jid) || []
        
        const contact = contactStore.get(jid)
        const profilePic = await sock.profilePictureUrl(jid).catch(() => null)
        const status = await sock.fetchStatus(jid).catch(() => null)
        
        // Pagination
        const startIndex = Math.max(0, messages.length - parseInt(limit) - parseInt(offset))
        const endIndex = messages.length - parseInt(offset)
        const paginatedMessages = messages.slice(startIndex, endIndex)
        
        const formattedMessages = paginatedMessages.map(msg => ({
            id: msg.key.id,
            fromMe: msg.key.fromMe,
            timestamp: msg.messageTimestamp,
            message: extractMessageContent(msg.message),
            messageType: getContentType(msg.message),
            quoted: msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? true : false
        }))
        
        res.json({
            number: number,
            jid: jid,
            contact: {
                name: contact?.name || contact?.notify || contact?.verifiedName,
                profilePicture: profilePic,
                status: status?.status,
                lastSeen: status?.setAt,
                isMyContact: contact?.name ? true : false
            },
            chat: {
                messages: formattedMessages,
                total: messages.length,
                showing: formattedMessages.length,
                hasMore: startIndex > 0,
                isGroup: jid.endsWith('@g.us')
            },
            syncInfo: { isFullySynced, syncAttempts }
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/api/chat/exists/:number", (req, res) => {
    try {
        const { number } = req.params
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const jid = formatJid(number)
        const messages = chatStore.get(jid) || []
        const contact = contactStore.get(jid)
        
        res.json({
            number: number,
            jid: jid,
            exists: messages.length > 0,
            messageCount: messages.length,
            hasContact: !!contact,
            contactName: contact?.name || contact?.notify || contact?.verifiedName,
            lastActivity: messages.length > 0 ? messages[messages.length - 1].messageTimestamp : null,
            syncInfo: { isFullySynced, syncAttempts }
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/api/chat/stats/:number", async (req, res) => {
    try {
        const { number } = req.params
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const jid = formatJid(number)
        const messages = chatStore.get(jid) || []
        const contact = contactStore.get(jid)
        
        if (messages.length === 0) {
            return res.json({
                number: number,
                jid: jid,
                exists: false,
                message: "No chat history found",
                syncInfo: { isFullySynced, syncAttempts }
            })
        }
        
        // Calculate statistics
        const myMessages = messages.filter(msg => msg.key.fromMe)
        const theirMessages = messages.filter(msg => !msg.key.fromMe)
        const mediaMessages = messages.filter(msg => {
            const type = getContentType(msg.message)
            return ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type)
        })
        
        const firstMessage = messages[0]
        const lastMessage = messages[messages.length - 1]
        
        // Message types breakdown
        const messageTypes = {}
        messages.forEach(msg => {
            const type = getContentType(msg.message) || 'unknown'
            messageTypes[type] = (messageTypes[type] || 0) + 1
        })
        
        res.json({
            number: number,
            jid: jid,
            contact: {
                name: contact?.name || contact?.notify || contact?.verifiedName,
                isMyContact: contact?.name ? true : false
            },
            statistics: {
                totalMessages: messages.length,
                myMessages: myMessages.length,
                theirMessages: theirMessages.length,
                mediaMessages: mediaMessages.length,
                messageTypes: messageTypes,
                firstMessage: {
                    timestamp: firstMessage.messageTimestamp,
                    fromMe: firstMessage.key.fromMe
                },
                lastMessage: {
                    timestamp: lastMessage.messageTimestamp,
                    fromMe: lastMessage.key.fromMe
                },
                chatDuration: lastMessage.messageTimestamp - firstMessage.messageTimestamp
            },
            syncInfo: { isFullySynced, syncAttempts }
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/chats/bulk-by-numbers", async (req, res) => {
    try {
        const { numbers, includeMessages = false, messageLimit = 10 } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        if (!Array.isArray(numbers)) {
            return res.status(400).json({ error: "Numbers must be an array" })
        }
        
        const results = []
        
        for (const number of numbers) {
            try {
                const jid = formatJid(number)
                const messages = chatStore.get(jid) || []
                const contact = contactStore.get(jid)
                
                const result = {
                    number: number,
                    jid: jid,
                    exists: messages.length > 0,
                    messageCount: messages.length,
                    contact: {
                        name: contact?.name || contact?.notify || contact?.verifiedName,
                        isMyContact: contact?.name ? true : false
                    }
                }
                
                if (includeMessages && messages.length > 0) {
                    const recentMessages = messages.slice(-parseInt(messageLimit))
                    result.recentMessages = recentMessages.map(msg => ({
                        id: msg.key.id,
                        fromMe: msg.key.fromMe,
                        timestamp: msg.messageTimestamp,
                        message: extractMessageContent(msg.message),
                        messageType: getContentType(msg.message)
                    }))
                }
                
                results.push(result)
            } catch (error) {
                results.push({
                    number: number,
                    error: error.message
                })
            }
        }
        
        res.json({
            results,
            total: results.length,
            withChats: results.filter(r => r.exists).length,
            withoutChats: results.filter(r => !r.exists && !r.error).length,
            errors: results.filter(r => r.error).length,
            syncInfo: { isFullySynced, syncAttempts }
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// =================== OTHER ENDPOINTS ===================

app.get("/api/contacts", async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const contacts = Array.from(contactStore.values())
        
        const enrichedContacts = []
        for (const contact of contacts.slice(0, 50)) {
            try {
                const profilePic = await sock.profilePictureUrl(contact.id, 'image').catch(() => null)
                const status = await sock.fetchStatus(contact.id).catch(() => null)
                
                enrichedContacts.push({
                    id: contact.id,
                    name: contact.name || contact.notify || contact.verifiedName,
                    profilePicture: profilePic,
                    status: status?.status,
                    isMyContact: contact.name ? true : false,
                    lastSeen: status?.setAt
                })
                
                await delay(100)
            } catch (error) {
                enrichedContacts.push({
                    id: contact.id,
                    name: contact.name || contact.notify || contact.verifiedName,
                    error: error.message
                })
            }
        }
        
        res.json({ 
            contacts: enrichedContacts,
            total: contactStore.size,
            showing: enrichedContacts.length,
            syncInfo: { isFullySynced, syncAttempts }
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/api/chats", async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const chats = Array.from(chatStore.keys()).map(chatId => {
            const messages = chatStore.get(chatId) || []
            const lastMessage = messages[messages.length - 1]
            
            return {
                id: chatId,
                isGroup: chatId.endsWith('@g.us'),
                messageCount: messages.length,
                lastMessage: lastMessage ? {
                    id: lastMessage.key.id,
                    message: extractMessageContent(lastMessage.message),
                    timestamp: lastMessage.messageTimestamp,
                    fromMe: lastMessage.key.fromMe
                } : null
            }
        })
        
        chats.sort((a, b) => {
            const aTime = a.lastMessage?.timestamp || 0
            const bTime = b.lastMessage?.timestamp || 0
            return bTime - aTime
        })
        
        res.json({ 
            chats,
            total: chats.length,
            syncInfo: { isFullySynced, syncAttempts }
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/api/messages/:jid", async (req, res) => {
    try {
        const { jid } = req.params
        const { limit = 50, offset = 0 } = req.query
        
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const formattedJid = formatJid(jid)
        const messages = chatStore.get(formattedJid) || []
        
        const startIndex = Math.max(0, messages.length - parseInt(limit) - parseInt(offset))
        const endIndex = messages.length - parseInt(offset)
        const paginatedMessages = messages.slice(startIndex, endIndex)
        
        const formattedMessages = paginatedMessages.map(msg => ({
            id: msg.key.id,
            fromMe: msg.key.fromMe,
            timestamp: msg.messageTimestamp,
            message: extractMessageContent(msg.message),
            messageType: getContentType(msg.message),
            quoted: msg.message?.extendedTextMessage?.contextInfo?.quotedMessage ? true : false
        }))
        
        res.json({
            jid: formattedJid,
            messages: formattedMessages,
            total: messages.length,
            showing: formattedMessages.length,
            hasMore: startIndex > 0,
            syncInfo: { isFullySynced, syncAttempts }
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/search-messages", async (req, res) => {
    try {
        const { query, jid, limit = 50 } = req.body
        
        if (!sock) return res.status(500).json({ error: "Not connected" })
        if (!query || query.length < 2) {
            return res.status(400).json({ error: "Query must be at least 2 characters" })
        }
        
        const results = []
        const searchQuery = query.toLowerCase()
        
        const chatsToSearch = jid ? [formatJid(jid)] : Array.from(chatStore.keys())
        
        for (const chatId of chatsToSearch) {
            const messages = chatStore.get(chatId) || []
            
            for (const msg of messages) {
                const content = extractMessageContent(msg.message)
                const messageText = content?.conversation || 
                                  content?.extendedTextMessage?.text || 
                                  content?.imageMessage?.caption ||
                                  content?.videoMessage?.caption || ''
                
                if (messageText.toLowerCase().includes(searchQuery)) {
                    results.push({
                        chatId,
                        messageId: msg.key.id,
                        fromMe: msg.key.fromMe,
                        timestamp: msg.messageTimestamp,
                        message: messageText,
                        messageType: getContentType(msg.message)
                    })
                    
                    if (results.length >= limit) break
                }
            }
            
            if (results.length >= limit) break
        }
        
        results.sort((a, b) => b.timestamp - a.timestamp)
        
        res.json({
            query: query,
            results,
            total: results.length,
            syncInfo: { isFullySynced, syncAttempts }
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/api/contact/:jid", async (req, res) => {
    try {
        const { jid } = req.params
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const formattedJid = formatJid(jid)
        const profilePic = await sock.profilePictureUrl(formattedJid).catch(() => null)
        const status = await sock.fetchStatus(formattedJid).catch(() => null)
        const businessProfile = await sock.getBusinessProfile(formattedJid).catch(() => null)
        
        res.json({
            jid: formattedJid,
            profilePicture: profilePic,
            status: status?.status,
            businessProfile,
            syncInfo: { isFullySynced, syncAttempts }
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/block/:jid", async (req, res) => {
    try {
        const { jid } = req.params
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        await sock.updateBlockStatus(formatJid(jid), 'block')
        res.json({ status: "Contact blocked" })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/unblock/:jid", async (req, res) => {
    try {
        const { jid } = req.params
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        await sock.updateBlockStatus(formatJid(jid), 'unblock')
        res.json({ status: "Contact unblocked" })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/check-numbers", async (req, res) => {
    try {
        const { numbers } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const results = []
        for (const number of numbers) {
            const jid = formatJid(number)
            const exists = await sock.onWhatsApp(jid)
            results.push({
                number,
                jid,
                exists: exists.length > 0,
                details: exists[0] || null
            })
            await delay(500)
        }
        
        res.json({ results })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// =================== SEND MESSAGE ENDPOINTS ===================

app.post("/api/send-text", async (req, res) => {
    try {
        const { to, message } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const result = await sock.sendMessage(formatJid(to), { text: message })
        res.json({ status: "ok", messageId: result.key.id })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/send-image", async (req, res) => {
    try {
        const { to, imageUrl, caption } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const response = await axios.get(imageUrl, { responseType: "arraybuffer" })
        const result = await sock.sendMessage(formatJid(to), { 
            image: response.data, 
            caption 
        })
        res.json({ status: "ok", messageId: result.key.id })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/send-video", async (req, res) => {
    try {
        const { to, videoUrl, caption } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const response = await axios.get(videoUrl, { responseType: "arraybuffer" })
        const result = await sock.sendMessage(formatJid(to), { 
            video: response.data, 
            caption 
        })
        res.json({ status: "ok", messageId: result.key.id })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/send-audio", async (req, res) => {
    try {
        const { to, audioUrl, ptt = false } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const response = await axios.get(audioUrl, { responseType: "arraybuffer" })
        const result = await sock.sendMessage(formatJid(to), { 
            audio: response.data, 
            ptt,
            mimetype: 'audio/mp4'
        })
        res.json({ status: "ok", messageId: result.key.id })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/send-document", async (req, res) => {
    try {
        const { to, documentUrl, fileName, mimetype } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const response = await axios.get(documentUrl, { responseType: "arraybuffer" })
        const result = await sock.sendMessage(formatJid(to), { 
            document: response.data,
            fileName: fileName || 'document',
            mimetype: mimetype || 'application/octet-stream'
        })
        res.json({ status: "ok", messageId: result.key.id })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/send-sticker", async (req, res) => {
    try {
        const { to, imageUrl } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const response = await axios.get(imageUrl, { responseType: "arraybuffer" })
        const result = await sock.sendMessage(formatJid(to), { sticker: response.data })
        res.json({ status: "ok", messageId: result.key.id })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/send-location", async (req, res) => {
    try {
        const { to, latitude, longitude, name } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const result = await sock.sendMessage(formatJid(to), { 
            location: { 
                degreesLatitude: parseFloat(latitude), 
                degreesLongitude: parseFloat(longitude),
                name
            } 
        })
        res.json({ status: "ok", messageId: result.key.id })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/send-contact", async (req, res) => {
    try {
        const { to, contacts } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const contactList = Array.isArray(contacts) ? contacts : [contacts]
        const vCards = contactList.map(contact => ({
            displayName: contact.name,
            vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${contact.name}\nTEL;type=CELL:${contact.number}\nEND:VCARD`
        }))
        
        const result = await sock.sendMessage(formatJid(to), { 
            contacts: { 
                displayName: `${contactList.length} contact${contactList.length > 1 ? 's' : ''}`,
                contacts: vCards
            } 
        })
        res.json({ status: "ok", messageId: result.key.id })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/send-poll", async (req, res) => {
    try {
        const { to, name, values, selectableCount = 1 } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const result = await sock.sendMessage(formatJid(to), {
            poll: {
                name,
                values,
                selectableCount: Math.min(selectableCount, values.length)
            }
        })
        res.json({ status: "ok", messageId: result.key.id })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/send-reaction", async (req, res) => {
    try {
        const { to, messageId, emoji } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const targetMessage = messageStore.get(messageId)
        if (!targetMessage) {
            return res.status(404).json({ error: "Message not found" })
        }
        
        const result = await sock.sendMessage(formatJid(to), { 
            react: { 
                text: emoji, 
                key: targetMessage.key 
            } 
        })
        res.json({ status: "ok", messageId: result.key.id })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/send-reply", async (req, res) => {
    try {
        const { to, message, quotedMessageId } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const quotedMessage = messageStore.get(quotedMessageId)
        if (!quotedMessage) {
            return res.status(404).json({ error: "Quoted message not found" })
        }
        
        const result = await sock.sendMessage(formatJid(to), { text: message }, { quoted: quotedMessage })
        res.json({ status: "ok", messageId: result.key.id })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/forward-message", async (req, res) => {
    try {
        const { messageId, to } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const targetMessage = messageStore.get(messageId)
        if (!targetMessage) {
            return res.status(404).json({ error: "Message not found" })
        }
        
        const recipients = Array.isArray(to) ? to : [to]
        const results = []
        
        for (const recipient of recipients) {
            try {
                const result = await sock.relayMessage(formatJid(recipient), targetMessage.message, {})
                results.push({ recipient: formatJid(recipient), status: 'sent', messageId: result.key.id })
            } catch (error) {
                results.push({ recipient: formatJid(recipient), status: 'failed', error: error.message })
            }
            await delay(1000)
        }
        
        res.json({ status: "ok", results })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.delete("/api/delete-message", async (req, res) => {
    try {
        const { messageId, to } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const targetMessage = messageStore.get(messageId)
        if (!targetMessage) {
            return res.status(404).json({ error: "Message not found" })
        }
        
        await sock.sendMessage(formatJid(to), { delete: targetMessage.key })
        res.json({ status: "ok" })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/read-messages", async (req, res) => {
    try {
        const { messageIds } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const keys = messageIds.map(id => {
            const msg = messageStore.get(id)
            return msg ? msg.key : null
        }).filter(Boolean)
        
        if (keys.length === 0) {
            return res.status(404).json({ error: "No valid messages found" })
        }
        
        await sock.readMessages(keys)
        res.json({ status: "ok", markedAsRead: keys.length })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// =================== GROUP MANAGEMENT ===================

app.post("/api/group-create", async (req, res) => {
    try {
        const { name, participants } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const participantJids = participants.map(jid => formatJid(jid))
        const group = await sock.groupCreate(name, participantJids)
        
        res.json({ status: "ok", groupId: group.id })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/api/groups", async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const groups = await sock.groupFetchAllParticipating()
        res.json({ groups: Object.values(groups) })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/api/group/:groupId/metadata", async (req, res) => {
    try {
        const { groupId } = req.params
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const metadata = await sock.groupMetadata(groupId)
        res.json({ group: metadata })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/group/:groupId/participants", async (req, res) => {
    try {
        const { groupId } = req.params
        const { participants, action } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const participantJids = participants.map(jid => formatJid(jid))
        const result = await sock.groupParticipantsUpdate(groupId, participantJids, action)
        
        res.json({ status: "ok", result })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/group/:groupId/subject", async (req, res) => {
    try {
        const { groupId } = req.params
        const { subject } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        await sock.groupUpdateSubject(groupId, subject)
        res.json({ status: "ok" })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/group/:groupId/description", async (req, res) => {
    try {
        const { groupId } = req.params
        const { description } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        await sock.groupUpdateDescription(groupId, description)
        res.json({ status: "ok" })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/group/:groupId/settings", async (req, res) => {
    try {
        const { groupId } = req.params
        const { setting, value } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        await sock.groupSettingUpdate(groupId, setting, value)
        res.json({ status: "ok" })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/api/group/:groupId/invite-code", async (req, res) => {
    try {
        const { groupId } = req.params
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const code = await sock.groupInviteCode(groupId)
        res.json({ 
            inviteCode: code, 
            inviteUrl: `https://chat.whatsapp.com/${code}`
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/group/:groupId/revoke-invite", async (req, res) => {
    try {
        const { groupId } = req.params
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const newCode = await sock.groupRevokeInvite(groupId)
        res.json({ 
            status: "ok", 
            newInviteCode: newCode,
            newInviteUrl: `https://chat.whatsapp.com/${newCode}`
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/group/:groupId/leave", async (req, res) => {
    try {
        const { groupId } = req.params
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        await sock.groupLeave(groupId)
        res.json({ status: "ok" })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// =================== MEDIA & UTILITIES ===================

app.post("/api/download-media", async (req, res) => {
    try {
        const { messageId } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const message = messageStore.get(messageId)
        if (!message) {
            return res.status(404).json({ error: "Message not found" })
        }
        
        const contentType = getContentType(message.message)
        if (!['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(contentType)) {
            return res.status(400).json({ error: "No downloadable media" })
        }
        
        const mediaData = await downloadMediaMessage(message, 'buffer', {})
        if (!mediaData) {
            return res.status(400).json({ error: "Failed to download media" })
        }
        
        const fileName = `media_${messageId}_${Date.now()}`
        const filePath = path.join(__dirname, "downloads", fileName)
        
        if (!fs.existsSync(path.dirname(filePath))) {
            fs.mkdirSync(path.dirname(filePath), { recursive: true })
        }
        
        fs.writeFileSync(filePath, mediaData)
        
        res.json({ 
            status: "ok", 
            fileName,
            filePath,
            contentType,
            size: mediaData.length
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get("/api/privacy", async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const privacy = await sock.fetchPrivacySettings()
        res.json({ privacySettings: privacy })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/privacy", async (req, res) => {
    try {
        const { setting, value } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        await sock.updatePrivacySettings({ [setting]: value })
        res.json({ status: "ok" })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/send-status", async (req, res) => {
    try {
        const { type, content } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        let statusMessage = {}
        
        if (type === 'text') {
            statusMessage = { text: content }
        } else if (type === 'image') {
            const response = await axios.get(content, { responseType: "arraybuffer" })
            statusMessage = { image: response.data }
        } else if (type === 'video') {
            const response = await axios.get(content, { responseType: "arraybuffer" })
            statusMessage = { video: response.data }
        }
        
        const result = await sock.sendMessage('status@broadcast', statusMessage)
        res.json({ status: "ok", messageId: result.key.id })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post("/api/send-broadcast", async (req, res) => {
    try {
        const { message, recipients, delay: msgDelay = 2000 } = req.body
        if (!sock) return res.status(500).json({ error: "Not connected" })
        
        const results = []
        
        for (let i = 0; i < recipients.length; i++) {
            try {
                const result = await sock.sendMessage(formatJid(recipients[i]), { text: message })
                results.push({ 
                    recipient: formatJid(recipients[i]), 
                    status: 'sent', 
                    messageId: result.key.id 
                })
                
                if (i < recipients.length - 1) {
                    await delay(parseInt(msgDelay))
                }
            } catch (error) {
                results.push({ 
                    recipient: formatJid(recipients[i]), 
                    status: 'failed', 
                    error: error.message 
                })
            }
        }
        
        res.json({ status: "ok", results })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})



app.get('/wml/me.wml', async (req, res) => {
  try {
    if (!sock) {
      sendWml(res, resultCard('Error', ['Not connected to WhatsApp'], '/wml/home.wml'))
      return
    }
    
    const user = sock.user
    let profilePic = null
    let status = null
    
    try {
      profilePic = await sock.profilePictureUrl(user.id).catch(() => null)
      status = await sock.fetchStatus(user.id).catch(() => null)
    } catch (e) {
      // Silent fail for optional features
    }
    
    const body = `
     
      <p><b>My Profile</b></p>
      <p>Name: <b>${esc(user?.name || user?.notify || 'Unknown')}</b></p>
      <p>Number: ${esc(user?.id?.replace('@s.whatsapp.net', '') || 'Unknown')}</p>
      <p>JID: <small>${esc(user?.id || 'Unknown')}</small></p>
      ${status ? `<p>Status: <em>${esc(status.status || 'No status')}</em></p>` : ''}
      
      <p><b>Profile Actions:</b></p>
      <p>
        <a href="/wml/profile.edit-name.wml" accesskey="1">[1] Edit Name</a><br/>
        <a href="/wml/profile.edit-status.wml" accesskey="2">[2] Edit Status</a><br/>
        <a href="/wml/profile.picture.wml" accesskey="3">[3] Profile Picture</a><br/>
      </p>
      
      <p><b>Account Info:</b></p>
      <p>Connected: ${esc(connectionState)}</p>
      <p>Sync Status: ${isFullySynced ? 'Complete' : 'In Progress'}</p>
      <p>Data: ${contactStore.size} contacts, ${chatStore.size} chats</p>
      
      ${navigationBar()}
      
      <do type="accept" label="Edit">
        <go href="/wml/profile.edit-name.wml"/>
      </do>
    `
    
    sendWml(res, card('me', 'My Profile', body))
  } catch (e) {
    sendWml(res, resultCard('Error', [e.message || 'Failed to load profile'], '/wml/home.wml'))
  }
})

// Presence page - was referenced but not implemented
app.get('/wml/presence.wml', (req, res) => {
  if (!sock) {
    sendWml(res, resultCard('Error', ['Not connected to WhatsApp'], '/wml/home.wml'))
    return
  }
  
  const body = `
    <p><b>Update Presence</b></p>
    <p>Set your availability status:</p>
    
    <p><b>Global Presence:</b></p>
    <p>
      <a href="/wml/presence.set.wml?type=available" accesskey="1">[1] Available</a><br/>
      <a href="/wml/presence.set.wml?type=unavailable" accesskey="2">[2] Unavailable</a><br/>
      <a href="/wml/presence.set.wml?type=composing" accesskey="3">[3] Typing</a><br/>
      <a href="/wml/presence.set.wml?type=recording" accesskey="4">[4] Recording</a><br/>
      <a href="/wml/presence.set.wml?type=paused" accesskey="5">[5] Paused</a><br/>
    </p>
    
    <p><b>Chat-Specific:</b></p>
    <p>Contact/Group JID:</p>
    <input name="jid" title="JID" size="20"/>
    
    <p>Presence type:</p>
    <select name="presence" title="Presence">
      <option value="available">Available</option>
      <option value="unavailable">Unavailable</option>
      <option value="composing">Typing</option>
      <option value="recording">Recording</option>
      <option value="paused">Paused</option>
    </select>
    
    <do type="accept" label="Set">
      <go method="post" href="/wml/presence.set">
        <postfield name="jid" value="$(jid)"/>
        <postfield name="presence" value="$(presence)"/>
      </go>
    </do>
    
    ${navigationBar()}
  `
  
  sendWml(res, card('presence', 'Presence', body))
})

// Privacy page - was referenced but not implemented
app.get('/wml/privacy.wml', async (req, res) => {
  try {
    if (!sock) {
      sendWml(res, resultCard('Error', ['Not connected to WhatsApp'], '/wml/home.wml'))
      return
    }
    
    let privacySettings = null
    try {
      privacySettings = await sock.fetchPrivacySettings()
    } catch (e) {
      // Silent fail
    }
    
    const body = `
    
      <p><b>Privacy Settings</b></p>
      
      ${privacySettings ? `
      <p><b>Current Settings:</b></p>
      <p>Last Seen: ${esc(privacySettings.lastSeen || 'Unknown')}</p>
      <p>Profile Photo: ${esc(privacySettings.profilePicture || 'Unknown')}</p>
      <p>Status: ${esc(privacySettings.status || 'Unknown')}</p>
      <p>Read Receipts: ${esc(privacySettings.readReceipts || 'Unknown')}</p>
      ` : '<p><em>Privacy settings unavailable</em></p>'}
      
      <p><b>Privacy Actions:</b></p>
      <p>
        <a href="/wml/privacy.lastseen.wml" accesskey="1">[1] Last Seen</a><br/>
        <a href="/wml/privacy.profile.wml" accesskey="2">[2] Profile Photo</a><br/>
        <a href="/wml/privacy.status.wml" accesskey="3">[3] Status Privacy</a><br/>
        <a href="/wml/privacy.receipts.wml" accesskey="4">[4] Read Receipts</a><br/>
        <a href="/wml/privacy.groups.wml" accesskey="5">[5] Groups</a><br/>
      </p>
      
      <p><b>Blocked Contacts:</b></p>
      <p>
        <a href="/wml/blocked.list.wml" accesskey="7">[7] View Blocked</a><br/>
        <a href="/wml/block.contact.wml" accesskey="8">[8] Block Contact</a><br/>
      </p>
      
      ${navigationBar()}
      
      <do type="accept" label="Refresh">
        <go href="/wml/privacy.wml"/>
      </do>
    `
    
    sendWml(res, card('privacy', 'Privacy', body))
  } catch (e) {
    sendWml(res, resultCard('Error', [e.message || 'Failed to load privacy settings'], '/wml/home.wml'))
  }
})

// =================== POST HANDLERS FOR QUICK ACTIONS ===================

// Presence setting handler
app.post('/wml/presence.set', async (req, res) => {
  try {
    const { jid, presence = 'available' } = req.body
    const type = req.query.type || presence
    
    if (!sock) {
      sendWml(res, resultCard('Error', ['Not connected to WhatsApp'], '/wml/presence.wml'))
      return
    }
    
    if (jid && jid.trim()) {
      await sock.sendPresenceUpdate(type, formatJid(jid.trim()))
      sendWml(res, resultCard('Presence Updated', [
        `Set ${type} for ${esc(jid.trim())}`,
        'Presence updated successfully'
      ], '/wml/presence.wml', true))
    } else {
      await sock.sendPresenceUpdate(type)
      sendWml(res, resultCard('Presence Updated', [
        `Global presence set to ${type}`,
        'Presence updated successfully'
      ], '/wml/presence.wml', true))
    }
  } catch (e) {
    sendWml(res, resultCard('Presence Failed', [e.message || 'Failed to update presence'], '/wml/presence.wml'))
  }
})

// Quick presence setting via GET for simple links
app.get('/wml/presence.set.wml', async (req, res) => {
  try {
    const { type = 'available', jid } = req.query
    
    if (!sock) {
      sendWml(res, resultCard('Error', ['Not connected to WhatsApp'], '/wml/presence.wml'))
      return
    }
    
    if (jid && jid.trim()) {
      await sock.sendPresenceUpdate(type, formatJid(jid.trim()))
      sendWml(res, resultCard('Presence Updated', [
        `Set ${type} for ${esc(jid.trim())}`,
        'Presence updated successfully'
      ], '/wml/presence.wml', true))
    } else {
      await sock.sendPresenceUpdate(type)
      sendWml(res, resultCard('Global Presence Updated', [
        `Presence set to: ${type}`,
        'All contacts will see this status'
      ], '/wml/presence.wml', true))
    }
  } catch (e) {
    sendWml(res, resultCard('Presence Failed', [e.message || 'Failed to update presence'], '/wml/presence.wml'))
  }
})

// =================== MISSING UTILITY ENDPOINTS ===================

// Broadcast page - was referenced but missing
app.get('/wml/broadcast.wml', (req, res) => {
  const body = `
    <p><b>Broadcast Message</b></p>
    <p>Send message to multiple contacts</p>
    
    <p>Recipients (comma-separated):</p>
    <input name="recipients" title="Phone numbers" size="25" maxlength="500"/>
    
    <p>Message:</p>
    <input name="message" title="Your message" size="30" maxlength="1000"/>
    
    <p>Delay between sends (ms):</p>
    <select name="delay" title="Delay">
      <option value="1000">1 second</option>
      <option value="2000">2 seconds</option>
      <option value="5000">5 seconds</option>
      <option value="10000">10 seconds</option>
    </select>
    
    <do type="accept" label="Send">
      <go method="post" href="/wml/broadcast.send">
        <postfield name="recipients" value="$(recipients)"/>
        <postfield name="message" value="$(message)"/>
        <postfield name="delay" value="$(delay)"/>
      </go>
    </do>
    
    <p>
      <a href="/wml/contacts.wml" accesskey="1">[1] Select from Contacts</a> |
      <a href="/wml/home.wml" accesskey="0">[0] Home</a>
    </p>
  `
  
  sendWml(res, card('broadcast', 'Broadcast', body))
})

// Debug page - was referenced but missing  
app.get('/wml/debug.wml', (req, res) => {
  const memUsage = process.memoryUsage()
  const uptime = Math.floor(process.uptime())
  
  const body = `

    <p><b>Debug Information</b></p>
    
    <p><b>Connection:</b></p>
    <p>State: ${esc(connectionState)}</p>
    <p>Socket: ${sock ? 'Active' : 'Null'}</p>
    <p>User: ${sock?.user?.id ? esc(sock.user.id) : 'None'}</p>
    <p>QR: ${currentQR ? 'Available' : 'None'}</p>
    
    <p><b>Data Stores:</b></p>
    <p>Contacts: ${contactStore.size}</p>
    <p>Chats: ${chatStore.size}</p>
    <p>Messages: ${messageStore.size}</p>
    <p>Sync Status: ${isFullySynced ? 'Complete' : 'Pending'}</p>
    <p>Sync Attempts: ${syncAttempts}</p>
    
    <p><b>System:</b></p>
    <p>Uptime: ${uptime}s</p>
    <p>Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB</p>
    <p>Node: ${process.version}</p>
    <p>Env: ${process.env.NODE_ENV || 'dev'}</p>
    
    <p><b>Debug Actions:</b></p>
    <p>
      <a href="/wml/debug.stores.wml" accesskey="1">[1] Store Details</a><br/>
      <a href="/wml/debug.logs.wml" accesskey="2">[2] Recent Logs</a><br/>
      <a href="/wml/debug.test.wml" accesskey="3">[3] Connection Test</a><br/>
    </p>
    
    ${navigationBar()}
    
    <do type="accept" label="Refresh">
      <go href="/wml/debug.wml"/>
    </do>
  `
  
  sendWml(res, card('debug', 'Debug', body, '/wml/debug.wml'))
})

// Logout confirmation page
app.get('/wml/logout.wml', (req, res) => {
  const body = `
    <p><b>Logout Confirmation</b></p>
    <p>This will:</p>
    <p>• Disconnect from WhatsApp</p>
    <p>• Clear all session data</p>
    <p>• Remove authentication</p>
    <p>• Clear local contacts/chats</p>
    
    <p><b>Are you sure?</b></p>
    <p>
      <a href="/wml/logout.confirm.wml" accesskey="1">[1] Yes, Logout</a><br/>
      <a href="/wml/home.wml" accesskey="0">[0] Cancel</a><br/>
    </p>
    
    <do type="accept" label="Cancel">
      <go href="/wml/home.wml"/>
    </do>
  `
  
  sendWml(res, card('logout', 'Logout', body))
})

// Logout execution
app.get('/wml/logout.confirm.wml', async (req, res) => {
  try {
    if (sock) {
      await sock.logout()
    }
    
    // Clear auth files
    if (fs.existsSync('./auth_info_baileys')) {
      fs.rmSync('./auth_info_baileys', { recursive: true })
    }
    
    // Clear stores
    contactStore.clear()
    chatStore.clear()
    messageStore.clear()
    isFullySynced = false
    syncAttempts = 0
    currentQR = null
    connectionState = 'disconnected'
    
    sendWml(res, resultCard('Logged Out', [
      'Successfully logged out',
      'All data cleared',
      'You can scan QR to reconnect'
    ], '/wml/home.wml', true))
  } catch (e) {
    sendWml(res, resultCard('Logout Error', [e.message || 'Logout failed'], '/wml/home.wml'))
  }
})

// =================== SYNC ENDPOINTS ===================

// Force sync endpoints that were referenced but missing handlers
app.get('/wml/sync.full.wml', async (req, res) => {
  try {
    if (!sock) {
      sendWml(res, resultCard('Error', ['Not connected to WhatsApp'], '/wml/status.wml'))
      return
    }
    
    // Trigger the existing performInitialSync function
    performInitialSync()
    
    sendWml(res, resultCard('Sync Started', [
      'Full sync initiated',
      'This may take a few minutes',
      'Check status page for progress'
    ], '/wml/status.wml', true))
  } catch (e) {
    sendWml(res, resultCard('Sync Failed', [e.message || 'Failed to start sync'], '/wml/status.wml'))
  }
})

app.get('/wml/sync.contacts.wml', async (req, res) => {
  try {
    if (!sock) {
      sendWml(res, resultCard('Error', ['Not connected to WhatsApp'], '/wml/status.wml'))
      return
    }
    
    const initialCount = contactStore.size
    
    // Wait for contact events (contacts sync automatically in Baileys)
    await delay(3000)
    
    const finalCount = contactStore.size
    const newContacts = finalCount - initialCount
    
    sendWml(res, resultCard('Contact Sync Complete', [
      `Initial contacts: ${initialCount}`,
      `Final contacts: ${finalCount}`,
      `New contacts: ${newContacts}`,
      'Contacts sync via WhatsApp events'
    ], '/wml/status.wml', true))
  } catch (e) {
    sendWml(res, resultCard('Contact Sync Failed', [e.message || 'Failed to sync contacts'], '/wml/status.wml'))
  }
})

app.get('/wml/sync.chats.wml', async (req, res) => {
  try {
    if (!sock) {
      sendWml(res, resultCard('Error', ['Not connected to WhatsApp'], '/wml/status.wml'))
      return
    }
    
    const initialCount = chatStore.size
    
    // Fetch groups (the main chat sync method available)
    const groups = await sock.groupFetchAllParticipating()
    Object.keys(groups).forEach(chatId => {
      if (!chatStore.has(chatId)) {
        chatStore.set(chatId, [])
      }
    })
    
    await delay(2000) // Wait for additional chat events
    
    const finalCount = chatStore.size
    const newChats = finalCount - initialCount
    
    sendWml(res, resultCard('Chat Sync Complete', [
      `Groups fetched: ${Object.keys(groups).length}`,
      `Initial chats: ${initialCount}`,
      `Final chats: ${finalCount}`,
      `New chats: ${newChats}`
    ], '/wml/status.wml', true))
  } catch (e) {
    sendWml(res, resultCard('Chat Sync Failed', [e.message || 'Failed to sync chats'], '/wml/status.wml'))
  }
})

// =================== ERROR HANDLING & SERVER SETUP ===================

// Error handling
app.use((err, req, res, next) => {
    console.error('Server Error:', err)
    res.status(500).json({ 
        error: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
    })
})

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found',
        path: req.path,
        method: req.method,
        suggestion: 'Check the API documentation for available endpoints'
    })
})

module.exports = { app, sock, contactStore, chatStore, messageStore }