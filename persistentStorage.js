// persistentStorage.js - Add this as a new file
const fs = require('fs')
const path = require('path')

class PersistentStorage {
  constructor(dataDir = './data') {
    this.dataDir = dataDir
    this.contactsFile = path.join(dataDir, 'contacts.json')
    this.chatsFile = path.join(dataDir, 'chats.json')
    this.messagesFile = path.join(dataDir, 'messages.json')
    this.metaFile = path.join(dataDir, 'meta.json')
    
    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }
    
    this.saveQueue = new Map()
    this.isProcessing = false
  }

  // Load data from files on startup
  loadAllData() {
    const result = {
      contacts: new Map(),
      chats: new Map(),
      messages: new Map(),
      meta: {
        lastSync: null,
        isFullySynced: false,
        syncAttempts: 0
      }
    }

    try {
      // Load contacts
      if (fs.existsSync(this.contactsFile)) {
        const contactsData = JSON.parse(fs.readFileSync(this.contactsFile, 'utf8'))
        result.contacts = new Map(contactsData)
        console.log(`📱 Loaded ${result.contacts.size} contacts from disk`)
      }

      // Load chats
      if (fs.existsSync(this.chatsFile)) {
        const chatsData = JSON.parse(fs.readFileSync(this.chatsFile, 'utf8'))
        result.chats = new Map(chatsData.map(([key, messages]) => [key, messages]))
        console.log(`💬 Loaded ${result.chats.size} chats from disk`)
      }

      // Load messages
      if (fs.existsSync(this.messagesFile)) {
        const messagesData = JSON.parse(fs.readFileSync(this.messagesFile, 'utf8'))
        result.messages = new Map(messagesData)
        console.log(`📨 Loaded ${result.messages.size} messages from disk`)
      }

      // Load metadata
      if (fs.existsSync(this.metaFile)) {
        const metaData = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'))
        result.meta = { ...result.meta, ...metaData }
        console.log(`⚙️ Loaded metadata from disk`)
      }

      console.log(`✅ Successfully loaded all data from persistent storage`)
      return result
    } catch (error) {
      console.error(`❌ Error loading data from disk:`, error.message)
      return result // Return empty maps if loading fails
    }
  }

  // Queue a save operation (debounced to avoid excessive writes)
  queueSave(type, data) {
    this.saveQueue.set(type, data)
    
    // Process queue after a short delay (debounce multiple rapid saves)
    if (!this.isProcessing) {
      this.isProcessing = true
      setTimeout(() => this.processSaveQueue(), 2000) // 2 second debounce
    }
  }

  // Process all queued save operations
  async processSaveQueue() {
    const operations = Array.from(this.saveQueue.entries())
    this.saveQueue.clear()
    this.isProcessing = false

    for (const [type, data] of operations) {
      try {
        await this.saveToFile(type, data)
      } catch (error) {
        console.error(`❌ Failed to save ${type}:`, error.message)
      }
    }
  }

  // Save data to appropriate file
  async saveToFile(type, data) {
    let filePath, serializedData

    switch (type) {
      case 'contacts':
        filePath = this.contactsFile
        serializedData = JSON.stringify(Array.from(data.entries()), null, 2)
        break
      
      case 'chats':
        filePath = this.chatsFile
        // Convert Map to array format for JSON serialization
        serializedData = JSON.stringify(Array.from(data.entries()), null, 2)
        break
      
      case 'messages':
        filePath = this.messagesFile
        serializedData = JSON.stringify(Array.from(data.entries()), null, 2)
        break
      
      case 'meta':
        filePath = this.metaFile
        serializedData = JSON.stringify(data, null, 2)
        break
      
      default:
        console.warn(`⚠️ Unknown save type: ${type}`)
        return
    }

    // Write to temporary file first, then rename (atomic operation)
    const tempFile = `${filePath}.tmp`
    fs.writeFileSync(tempFile, serializedData, 'utf8')
    fs.renameSync(tempFile, filePath)
    
    console.log(`💾 Saved ${type} to disk`)
  }

  // Immediate save (for critical data)
  saveImmediately(type, data) {
    return this.saveToFile(type, data)
  }

  // Clean up old message data to prevent files from growing too large
  cleanupOldMessages(messageStore, chatStore, maxMessagesPerChat = 100) {
    let cleaned = 0
    
    for (const [chatId, messages] of chatStore.entries()) {
      if (messages.length > maxMessagesPerChat) {
        // Keep only the most recent messages
        const oldMessages = messages.splice(0, messages.length - maxMessagesPerChat)
        
        // Remove old message references from messageStore
        for (const msg of oldMessages) {
          if (msg.key?.id && messageStore.has(msg.key.id)) {
            messageStore.delete(msg.key.id)
            cleaned++
          }
        }
      }
    }
    
    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} old messages`)
      this.queueSave('messages', messageStore)
      this.queueSave('chats', chatStore)
    }
  }

  // Export data for backup
  exportData() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = path.join(this.dataDir, 'backups')
    
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true })
    }
    
    const backupFile = path.join(backupDir, `backup-${timestamp}.json`)
    const data = this.loadAllData()
    
    const exportData = {
      timestamp: new Date().toISOString(),
      contacts: Array.from(data.contacts.entries()),
      chats: Array.from(data.chats.entries()),
      messages: Array.from(data.messages.entries()),
      meta: data.meta
    }
    
    fs.writeFileSync(backupFile, JSON.stringify(exportData, null, 2))
    console.log(`📦 Data exported to ${backupFile}`)
    
    return backupFile
  }
}

module.exports = PersistentStorage